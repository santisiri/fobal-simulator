// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "./BaseFixture.sol";
import {FobalMatchEscrow} from "../src/FobalMatchEscrow.sol";
import {FobalTypes} from "../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../src/libraries/PlayerCodec.sol";

/// @notice The Definition of Done, executed end to end as one test:
/// Alice generates Fobal FC (11 on-chain players) → creates a match vs Bob →
/// both stake ETH → players lock → engine signs a result → contract verifies
/// → players evolve, career grows, metadata changes → stake settles → players
/// unlock → Alice lists an evolved player → Bob buys → the player's DNA,
/// avatar, abilities, XP and career survive the transfer unchanged.
contract VerticalSliceTest is BaseFixture {
    function test_definitionOfDone() public {
        // 1-3. Alice generates Fobal FC: 11 unique on-chain players.
        uint256[] memory fobalFc = mintSquadFor(alice, 1, 11);
        uint256[] memory bobFc = mintSquadFor(bob, 2, 11);
        assertEq(player.balanceOf(alice), 11);

        // each player is fully on-chain: distinct dna + a real tokenURI/SVG
        for (uint256 i; i < 11; ++i) {
            assertTrue(player.dnaOf(fobalFc[i]) != bytes32(0));
            string memory uri = player.tokenURI(fobalFc[i]);
            assertTrue(bytes(uri).length > 500, "on-chain metadata present");
        }

        // 4. Team identity on-chain.
        vm.prank(alice);
        uint64 teamId = teams.createTeam("Fobal FC", keccak256("fobal-team-dna"));
        assertEq(teams.ownerOfTeam(teamId), alice);

        // 5-8. Alice creates a match vs Bob; both stake ETH; players lock.
        vm.prank(alice);
        bytes32 matchId = escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            1 ether,
            keccak256("champions-rules"),
            bob,
            1 days,
            1 days,
            teamId,
            fobalFc
        );
        vm.prank(bob);
        escrow.joinMatch{value: 1 ether}(matchId, 2, bobFc);
        assertEq(player.lockedBy(fobalFc[9]), address(escrow), "committed players locked");
        // a locked player cannot be transferred
        vm.prank(alice);
        vm.expectRevert();
        player.transferFrom(alice, bob, fobalFc[9]);

        // snapshot the striker's identity BEFORE the match
        uint256 striker = fobalFc[9];
        bytes32 dnaBefore = player.dnaOf(striker);
        uint256 appearanceBefore = player.appearanceOf(striker);
        uint8 finishingBefore = PlayerCodec.skill(player.skillsOf(striker), 1);
        string memory uriBefore = player.tokenURI(striker);

        // 9-10. The off-chain engine produces a result and signs it; the
        // contract verifies. Alice's striker scored twice.
        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](2);
        progs[0] = defaultProgress(striker, 1); // win, +2 goals, +xp, +skills
        progs[1] = defaultProgress(bobFc[9], 2); // loss
        FobalMatchEscrow.MatchResult memory result = FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: teamId,
            teamB: 2,
            scoreA: 3,
            scoreB: 1,
            replayHash: keccak256("full-replay-blob"),
            statsRoot: keccak256("detailed-stats"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });
        escrow.settle(result, signResult(result), progs);

        // 11-12. Skills evolved and career stats grew.
        FobalTypes.PlayerView memory evolved = player.playerView(striker);
        assertEq(PlayerCodec.skill(evolved.skills, 1), finishingBefore + 1, "finishing +1");
        assertEq(evolved.core.xp, 80, "xp gained");
        assertEq(evolved.stats.matchesPlayed, 1);
        assertEq(evolved.stats.wins, 1);
        assertEq(evolved.stats.goals, 2);

        // metadata changed but immutable identity did not
        assertTrue(
            keccak256(bytes(player.tokenURI(striker))) != keccak256(bytes(uriBefore)), "metadata evolved"
        );
        assertEq(player.dnaOf(striker), dnaBefore, "dna immutable");
        assertEq(player.appearanceOf(striker), appearanceBefore, "appearance immutable");

        // 13-14. Stake settled to treasury; players unlocked.
        assertEq(escrow.withdrawable(treasury, address(0)), 2 ether);
        assertEq(player.lockedBy(striker), address(0), "unlocked after settle");

        // 15-16. Alice lists the evolved striker; Bob buys it.
        vm.prank(alice);
        player.setApprovalForAll(address(market), true);
        vm.prank(alice);
        market.list(striker, address(0), 5 ether, uint40(block.timestamp + 1 days));
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        market.buy{value: 5 ether}(striker);

        // 17. The player's evolved state survives the transfer, in full.
        assertEq(player.ownerOf(striker), bob, "ownership changed");
        FobalTypes.PlayerView memory sold = player.playerView(striker);
        assertEq(sold.dna, dnaBefore, "DNA survives");
        assertEq(sold.appearance, appearanceBefore, "avatar survives");
        assertEq(PlayerCodec.skill(sold.skills, 1), finishingBefore + 1, "abilities survive");
        assertEq(sold.core.xp, 80, "XP survives");
        assertEq(sold.stats.goals, 2, "career survives");
        assertEq(sold.stats.wins, 1, "career survives");

        // and Alice got paid (pull ledger), Bob owns a footballer with a past
        uint256 saleFee = (uint256(5 ether) * uint256(market.feeBps())) / 10_000;
        assertEq(market.withdrawable(alice, address(0)), uint256(5 ether) - saleFee);
    }
}
