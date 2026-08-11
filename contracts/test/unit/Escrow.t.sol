// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalAssetRegistry} from "../../src/FobalAssetRegistry.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {FundsLedger} from "../../src/libraries/FundsLedger.sol";
import {MockSairi, MockFeeOnTransferToken} from "../../src/mocks/MockSairi.sol";

contract EscrowTest is BaseFixture {
    uint256[] internal aliceTeam;
    uint256[] internal bobTeam;
    uint96 internal constant STAKE = 1 ether;

    function setUp() public override {
        super.setUp();
        aliceTeam = mintSquadFor(alice, 1, 11);
        bobTeam = mintSquadFor(bob, 2, 11);
    }

    function _create(FobalMatchEscrow.Mode mode) internal returns (bytes32 matchId) {
        vm.prank(alice);
        matchId = escrow.createMatch{value: STAKE}(
            mode, address(0), STAKE, keccak256("rules-v1"), address(0), 1 days, 1 days, 1, aliceTeam
        );
    }

    function _join(bytes32 matchId) internal {
        vm.prank(bob);
        escrow.joinMatch{value: STAKE}(matchId, 2, bobTeam);
    }

    function _result(bytes32 matchId, uint8 scoreA, uint8 scoreB, FobalTypes.PlayerProgress[] memory progs)
        internal
        view
        returns (FobalMatchEscrow.MatchResult memory)
    {
        return FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: 1,
            teamB: 2,
            scoreA: scoreA,
            scoreB: scoreB,
            replayHash: keccak256("replay"),
            statsRoot: keccak256("stats"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });
    }

    // ------------------------------------------------------------- lifecycle

    function test_fullLifecycle_progressionMode() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        assertEq(player.lockedBy(aliceTeam[0]), address(escrow), "created locks lineup");
        _join(matchId);
        assertEq(player.lockedBy(bobTeam[0]), address(escrow));

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](2);
        progs[0] = defaultProgress(aliceTeam[9], 1);
        progs[1] = defaultProgress(bobTeam[9], 2);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 2, 1, progs);
        escrow.settle(result, signResult(result), progs);

        // pot to treasury (pull ledger), players unlocked and progressed
        assertEq(escrow.withdrawable(treasury, address(0)), 2 ether);
        assertEq(player.lockedBy(aliceTeam[0]), address(0));
        assertEq(player.lockedBy(bobTeam[0]), address(0));
        assertEq(player.playerView(aliceTeam[9]).stats.wins, 1);
        assertEq(player.playerView(bobTeam[9]).stats.losses, 1);

        // treasury withdraws for real
        uint256 balBefore = treasury.balance;
        vm.prank(treasury);
        escrow.withdraw(address(0));
        assertEq(treasury.balance, balBefore + 2 ether);
    }

    function test_prizeMode_winnerTakesPotMinusFee() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PRIZE);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 0, 3, progs);
        escrow.settle(result, signResult(result), progs);

        uint256 pot = 2 ether;
        uint256 fee = (pot * 250) / 10_000;
        assertEq(escrow.withdrawable(bob, address(0)), pot - fee, "winner credit");
        assertEq(escrow.withdrawable(treasury, address(0)), fee, "fee credit");
        assertEq(escrow.withdrawable(alice, address(0)), 0, "loser gets nothing");
    }

    function test_prizeMode_drawRefundsBoth() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PRIZE);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 1, progs);
        escrow.settle(result, signResult(result), progs);
        assertEq(escrow.withdrawable(alice, address(0)), STAKE);
        assertEq(escrow.withdrawable(bob, address(0)), STAKE);
        assertEq(escrow.withdrawable(treasury, address(0)), 0);
    }

    function test_settleTwice_reverts() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, progs);
        bytes memory sig = signResult(result);
        escrow.settle(result, sig, progs);
        vm.expectRevert(
            abi.encodeWithSelector(
                FobalMatchEscrow.WrongStatus.selector, matchId, FobalMatchEscrow.Status.SETTLED
            )
        );
        escrow.settle(result, sig, progs);
    }

    // -------------------------------------------------------------- security

    function test_settle_rejectsBadSignature() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, progs);
        bytes32 digest = escrow.resultDigest(result);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(FobalMatchEscrow.InvalidSignature.selector);
        escrow.settle(result, abi.encodePacked(r, s, v), progs);
    }

    function test_settle_rejectsRotatedOutSigner() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, progs);
        bytes memory sig = signResult(result);
        vm.prank(admin);
        escrow.setSigner(makeAddr("newEngine"));
        vm.expectRevert(FobalMatchEscrow.InvalidSignature.selector);
        escrow.settle(result, sig, progs);
    }

    function test_settle_rejectsExpiredResult() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, progs);
        bytes memory sig = signResult(result);
        vm.warp(result.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.ResultInvalid.selector, "deadline"));
        escrow.settle(result, sig, progs);
    }

    function test_settle_rejectsProgressionHashMismatch() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory signedProgs = new FobalTypes.PlayerProgress[](1);
        signedProgs[0] = defaultProgress(aliceTeam[0], 1);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, signedProgs);
        bytes memory sig = signResult(result);
        // attacker swaps in juicier progression than the engine signed
        FobalTypes.PlayerProgress[] memory forged = new FobalTypes.PlayerProgress[](1);
        forged[0] = defaultProgress(aliceTeam[0], 1);
        forged[0].delta.xp = 200;
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.ResultInvalid.selector, "progression hash"));
        escrow.settle(result, sig, forged);
    }

    function test_settle_rejectsWrongTeams() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 1, 0, progs);
        result.teamB = 99;
        bytes memory sig = signResult(result);
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.ResultInvalid.selector, "teams"));
        escrow.settle(result, sig, progs);
    }

    // ----------------------------------------------------------- locks/entry

    function test_playerCannotEnterTwoMatches() public {
        _create(FobalMatchEscrow.Mode.PROGRESSION);
        // same lineup again → lock() reverts inside the second create
        vm.prank(alice);
        vm.expectRevert();
        escrow.createMatch{value: STAKE}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            STAKE,
            keccak256("rules"),
            address(0),
            1 days,
            1 days,
            1,
            aliceTeam
        );
    }

    function test_cannotStakeSomeoneElsesPlayers() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.NotPlayerOwner.selector, aliceTeam[0]));
        escrow.createMatch{value: STAKE}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            STAKE,
            keccak256("rules"),
            address(0),
            1 days,
            1 days,
            9,
            aliceTeam
        );
    }

    function test_cancelOpen_refundsAndUnlocks() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        vm.prank(alice);
        escrow.cancelOpen(matchId);
        assertEq(escrow.withdrawable(alice, address(0)), STAKE);
        assertEq(player.lockedBy(aliceTeam[0]), address(0));
        vm.prank(alice);
        escrow.withdraw(address(0));
    }

    function test_cancelExpired_engineNoShow() public {
        bytes32 matchId = _create(FobalMatchEscrow.Mode.PROGRESSION);
        _join(matchId);
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.ResultDeadlineNotReached.selector, matchId));
        vm.prank(bob);
        escrow.cancelExpired(matchId);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(bob);
        escrow.cancelExpired(matchId);
        assertEq(escrow.withdrawable(alice, address(0)), STAKE);
        assertEq(escrow.withdrawable(bob, address(0)), STAKE);
        assertEq(player.lockedBy(aliceTeam[5]), address(0));
        assertEq(player.lockedBy(bobTeam[5]), address(0));
    }

    function test_designatedOpponentOnly() public {
        vm.prank(alice);
        bytes32 matchId = escrow.createMatch{value: STAKE}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            STAKE,
            keccak256("rules"),
            bob,
            1 days,
            1 days,
            1,
            aliceTeam
        );
        address charlie = makeAddr("charlie");
        vm.deal(charlie, 5 ether);
        uint256[] memory charlieTeam = mintSquadFor(charlie, 3, 11);
        vm.prank(charlie);
        vm.expectRevert(abi.encodeWithSelector(FobalMatchEscrow.NotDesignatedOpponent.selector, matchId));
        escrow.joinMatch{value: STAKE}(matchId, 3, charlieTeam);
    }

    // ---------------------------------------------------------------- ERC-20

    function test_erc20_stakingLifecycle() public {
        MockSairi sairi = new MockSairi();
        vm.prank(admin);
        assets.setAsset(
            address(sairi),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 1e18, maxStake: 1_000_000e18, progressionMultiplierBps: 10_000
            })
        );
        sairi.mint(alice, 1000e18);
        sairi.mint(bob, 1000e18);
        vm.prank(alice);
        sairi.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        sairi.approve(address(escrow), type(uint256).max);

        vm.prank(alice);
        bytes32 matchId = escrow.createMatch(
            FobalMatchEscrow.Mode.PRIZE,
            address(sairi),
            100e18,
            keccak256("rules"),
            address(0),
            1 days,
            1 days,
            1,
            aliceTeam
        );
        vm.prank(bob);
        escrow.joinMatch(matchId, 2, bobTeam);

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(matchId, 4, 0, progs);
        escrow.settle(result, signResult(result), progs);

        uint256 fee = (200e18 * 250) / 10_000;
        assertEq(escrow.withdrawable(alice, address(sairi)), 200e18 - fee);
        uint256 before = sairi.balanceOf(alice);
        vm.prank(alice);
        escrow.withdraw(address(sairi));
        assertEq(sairi.balanceOf(alice), before + 200e18 - fee);
    }

    function test_feeOnTransferToken_rejected() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        vm.prank(admin);
        assets.setAsset(
            address(feeToken),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 1e18, maxStake: 1_000e18, progressionMultiplierBps: 10_000
            })
        );
        feeToken.mint(alice, 100e18);
        vm.startPrank(alice);
        feeToken.approve(address(escrow), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(FundsLedger.NonStandardToken.selector, address(feeToken)));
        escrow.createMatch(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(feeToken),
            10e18,
            keccak256("rules"),
            address(0),
            1 days,
            1 days,
            1,
            aliceTeam
        );
        vm.stopPrank();
    }

    function test_disabledAsset_rejected() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FobalAssetRegistry.AssetDisabled.selector, address(0xDEAD)));
        escrow.createMatch(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0xDEAD),
            1 ether,
            keccak256("rules"),
            address(0),
            1 days,
            1 days,
            1,
            aliceTeam
        );
    }

    // ------------------------------------------------------------ accounting

    function test_conservation_everyWeiAccounted() public {
        bytes32 m1 = _create(FobalMatchEscrow.Mode.PRIZE);
        _join(m1);
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = _result(m1, 2, 0, progs);
        escrow.settle(result, signResult(result), progs);
        // contract balance equals the sum of unwithdrawn credits
        uint256 credits = escrow.withdrawable(alice, address(0)) + escrow.withdrawable(bob, address(0))
            + escrow.withdrawable(treasury, address(0));
        assertEq(address(escrow).balance, credits);
        // bob lost 2-0: nothing to withdraw
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FundsLedger.NothingToWithdraw.selector, address(0)));
        escrow.withdraw(address(0));
        // alice (winner) drains her credit; escrow balance falls to match
        vm.prank(alice);
        escrow.withdraw(address(0));
        assertEq(address(escrow).balance, escrow.withdrawable(treasury, address(0)));
    }
}
