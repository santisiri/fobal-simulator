// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalMatchEscrow} from "../../src/FobalMatchEscrow.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../../src/libraries/PlayerCodec.sol";
import {ProgressionMath} from "../../src/libraries/ProgressionMath.sol";

contract FuzzTest is BaseFixture {
    function testFuzz_skillPackRoundTrips(uint8[12] memory values) public pure {
        uint256 packed;
        for (uint256 i; i < 12; ++i) {
            packed = PlayerCodec.setSkill(packed, i, values[i]);
        }
        for (uint256 i; i < 12; ++i) {
            assertEq(PlayerCodec.skill(packed, i), values[i]);
        }
    }

    function testFuzz_validSkillsBoundary(uint8 value, uint8 lane) public pure {
        lane = uint8(bound(lane, 0, 11));
        uint256 packed = PlayerCodec.setSkill(0, lane, value);
        assertEq(PlayerCodec.validSkills(packed), value <= 100);
    }

    function testFuzz_progressionNeverExceedsCap(uint8 lane, uint8 delta) public {
        lane = uint8(bound(lane, 0, 11));
        delta = uint8(bound(delta, 0, 2)); // within policy per-skill cap
        uint256[] memory ids = mintSquadFor(alice, 0, 1);
        uint256 tokenId = ids[0];
        uint8 startSkill = PlayerCodec.skill(player.skillsOf(tokenId), lane);

        FobalTypes.ProgressionDelta memory d;
        d.skillDeltas = PlayerCodec.setSkill(0, lane, delta);
        // may revert if it would cross 100 — but it can NEVER land above 100
        vm.prank(address(progression));
        try player.applyProgression(tokenId, d) {
            uint8 after_ = PlayerCodec.skill(player.skillsOf(tokenId), lane);
            assertLe(after_, 100);
            assertGe(after_, startSkill); // never decreases
        } catch {
            assertGt(uint256(startSkill) + delta, 100); // only reason to revert
        }
    }

    function testFuzz_levelMonotonicInXp(uint32 xpA, uint32 xpB) public pure {
        if (xpA > xpB) (xpA, xpB) = (xpB, xpA);
        assertLe(ProgressionMath.levelForXp(xpA), ProgressionMath.levelForXp(xpB));
        assertLe(ProgressionMath.levelForXp(xpB), 99);
    }

    function testFuzz_ethStake_conserved(uint96 stake) public {
        stake = uint96(bound(stake, 0.001 ether, 50 ether));
        uint256[] memory aTeam = mintSquadFor(alice, 1, 1);
        uint256[] memory bTeam = mintSquadFor(bob, 2, 1);
        vm.deal(alice, stake);
        vm.deal(bob, stake);

        vm.prank(alice);
        bytes32 matchId = escrow.createMatch{value: stake}(
            FobalMatchEscrow.Mode.PRIZE,
            address(0),
            stake,
            keccak256("r"),
            address(0),
            1 days,
            1 days,
            1,
            aTeam
        );
        vm.prank(bob);
        escrow.joinMatch{value: stake}(matchId, 2, bTeam);

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](0);
        FobalMatchEscrow.MatchResult memory result = FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: 1,
            teamB: 2,
            scoreA: 2,
            scoreB: 0,
            replayHash: keccak256("r"),
            statsRoot: keccak256("s"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });
        escrow.settle(result, signResult(result), progs);

        // every wei in == every wei creditable out
        uint256 pot = uint256(stake) * 2;
        uint256 credited = escrow.withdrawable(alice, address(0)) + escrow.withdrawable(bob, address(0))
            + escrow.withdrawable(treasury, address(0));
        assertEq(credited, pot);
        assertEq(address(escrow).balance, pot);
    }

    function testFuzz_feeNeverExceedsPot(uint96 stake, uint16 fee) public {
        stake = uint96(bound(stake, 0.001 ether, 50 ether));
        fee = uint16(bound(fee, 0, escrow.MAX_FEE_BPS()));
        vm.prank(admin);
        escrow.setFeeBps(fee);
        uint256 pot = uint256(stake) * 2;
        uint256 feeAmount = (pot * fee) / 10_000;
        assertLe(feeAmount, pot / 10); // <= 10% by the hard cap
    }
}
