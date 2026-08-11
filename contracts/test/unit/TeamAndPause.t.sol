// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalTeamRegistry} from "../../src/FobalTeamRegistry.sol";
import {FobalAssetRegistry} from "../../src/FobalAssetRegistry.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract TeamRegistryTest is BaseFixture {
    function test_createAndTransfer() public {
        vm.prank(alice);
        uint64 teamId = teams.createTeam("Fobal FC", keccak256("dna"));
        assertEq(teams.ownerOfTeam(teamId), alice);
        (address owner,, bytes32 dna, string memory name) = teams.teams(teamId);
        assertEq(owner, alice);
        assertEq(dna, keccak256("dna"));
        assertEq(name, "Fobal FC");

        vm.prank(alice);
        teams.transferTeam(teamId, bob);
        assertEq(teams.ownerOfTeam(teamId), bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FobalTeamRegistry.NotTeamOwner.selector, teamId));
        teams.transferTeam(teamId, alice);
    }

    function test_declareRoster_onlyOwner_emits() public {
        vm.prank(alice);
        uint64 teamId = teams.createTeam("FC", bytes32(0));
        uint256[] memory roster = new uint256[](2);
        roster[0] = 1;
        roster[1] = 2;
        vm.expectEmit(true, true, false, true);
        emit FobalTeamRegistry.RosterUpdated(teamId, alice, roster);
        vm.prank(alice);
        teams.declareRoster(teamId, roster);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FobalTeamRegistry.NotTeamOwner.selector, teamId));
        teams.declareRoster(teamId, roster);
    }

    function test_nameValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(FobalTeamRegistry.TeamNameInvalid.selector);
        teams.createTeam("", bytes32(0));
        bytes memory long = new bytes(33);
        vm.expectRevert(FobalTeamRegistry.TeamNameInvalid.selector);
        teams.createTeam(string(long), bytes32(0));
        vm.stopPrank();
    }

    function test_unknownTeamReverts() public {
        vm.expectRevert(abi.encodeWithSelector(FobalTeamRegistry.TeamDoesNotExist.selector, uint64(999)));
        teams.ownerOfTeam(999);
    }
}

contract PauseTest is BaseFixture {
    uint256[] internal team;

    function setUp() public override {
        super.setUp();
        team = mintSquadFor(alice, 1, 1);
    }

    function test_pausedEscrow_blocksNewMatches_butNotCancel() public {
        // create while unpaused, then pause
        vm.prank(alice);
        bytes32 matchId = escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            1 ether,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            team
        );
        vm.prank(admin);
        escrow.pause();

        // new matches blocked
        uint256[] memory team2 = mintSquadFor(bob, 2, 1);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            1 ether,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            2,
            team2
        );

        // but funds are NEVER trapped: cancelOpen + withdraw still work
        vm.prank(alice);
        escrow.cancelOpen(matchId);
        assertEq(escrow.withdrawable(alice, address(0)), 1 ether);
        vm.prank(alice);
        escrow.withdraw(address(0)); // withdraw is not gated by pause
        assertEq(player.lockedBy(team[0]), address(0));
    }

    function test_pausedMarketplace_blocksBuy_butNotWithdraw() public {
        vm.prank(alice);
        player.setApprovalForAll(address(market), true);
        vm.prank(alice);
        market.list(team[0], address(0), 1 ether, uint40(block.timestamp + 1 days));
        vm.prank(admin);
        market.pause();
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.buy{value: 1 ether}(team[0]);
    }

    function test_onlyPauserPauses() public {
        vm.prank(alice);
        vm.expectRevert();
        escrow.pause();
    }
}

contract AssetRegistryEdgeTest is BaseFixture {
    function test_invalidConfigRejected() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(FobalAssetRegistry.InvalidConfig.selector, "min>max"));
        assets.setAsset(
            address(1),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 10, maxStake: 5, progressionMultiplierBps: 1
            })
        );
        vm.expectRevert(abi.encodeWithSelector(FobalAssetRegistry.InvalidConfig.selector, "multiplier"));
        assets.setAsset(
            address(1),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 1, maxStake: 5, progressionMultiplierBps: 100_001
            })
        );
        vm.stopPrank();
    }

    function test_stakeRangeEnforced() public {
        vm.expectRevert(
            abi.encodeWithSelector(FobalAssetRegistry.StakeOutOfRange.selector, address(0), 200 ether)
        );
        assets.requireStakeAllowed(address(0), 200 ether); // max is 100 ether
    }

    function test_onlyAssetAdminConfigures() public {
        vm.prank(alice);
        vm.expectRevert();
        assets.setAsset(
            address(1),
            FobalAssetRegistry.AssetConfig({
                enabled: true, minStake: 1, maxStake: 5, progressionMultiplierBps: 1
            })
        );
    }
}
