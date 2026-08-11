// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalProgression} from "../../src/FobalProgression.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../../src/libraries/PlayerCodec.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice The policy layer: engine discretion, protocol caps. These tests
/// drive FobalProgression directly (as the escrow would) via a granted role.
contract ProgressionTest is BaseFixture {
    uint256 internal p1;
    uint256 internal p2;
    address internal escrowRole = makeAddr("escrowStandIn");

    function setUp() public override {
        super.setUp();
        uint256[] memory ids = mintSquadFor(alice, 0, 2);
        p1 = ids[0];
        p2 = ids[1];
        // grant the stand-in ESCROW_ROLE so we can call applyMatch directly.
        // NOTE: read the role BEFORE prank — an inner view call consumes it.
        bytes32 escrowRoleId = progression.ESCROW_ROLE();
        vm.prank(admin);
        progression.grantRole(escrowRoleId, escrowRole);
    }

    function _one(uint256 playerId, FobalTypes.ProgressionDelta memory d)
        internal
        pure
        returns (FobalTypes.PlayerProgress[] memory list)
    {
        list = new FobalTypes.PlayerProgress[](1);
        list[0] = FobalTypes.PlayerProgress({playerId: playerId, delta: d});
    }

    function test_onlyEscrowRoleCanApply() public {
        FobalTypes.PlayerProgress[] memory list = _one(p1, defaultProgress(p1, 1).delta);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, progression.ESCROW_ROLE()
            )
        );
        vm.prank(alice);
        progression.applyMatch(keccak256("m"), list, 10_000);
    }

    function test_consumedOncePerMatchPlayer() public {
        FobalTypes.PlayerProgress[] memory list = _one(p1, defaultProgress(p1, 1).delta);
        vm.startPrank(escrowRole);
        progression.applyMatch(keccak256("match-1"), list, 10_000);
        vm.expectRevert(
            abi.encodeWithSelector(FobalProgression.AlreadyProgressed.selector, keccak256("match-1"), p1)
        );
        progression.applyMatch(keccak256("match-1"), list, 10_000);
        vm.stopPrank();
    }

    function test_xpCapEnforced_andScaledByMultiplier() public {
        FobalTypes.ProgressionDelta memory d;
        d.xp = 201; // policy default cap 200
        FobalTypes.PlayerProgress[] memory list = _one(p1, d);
        vm.prank(escrowRole);
        vm.expectRevert(abi.encodeWithSelector(FobalProgression.PolicyViolated.selector, p1, "xp"));
        progression.applyMatch(keccak256("m"), list, 10_000);

        // a 2x asset multiplier lifts the ceiling to 400
        d.xp = 400;
        list = _one(p1, d);
        vm.prank(escrowRole);
        progression.applyMatch(keccak256("m2"), list, 20_000);
        assertEq(player.playerView(p1).core.xp, 400);
    }

    function test_skillDeltaCapFlat_moneyDoesNotBuyBiggerJumps() public {
        FobalTypes.ProgressionDelta memory d;
        d.skillDeltas = PlayerCodec.setSkill(0, 0, 3); // default per-skill cap 2
        FobalTypes.PlayerProgress[] memory list = _one(p1, d);
        // even at a huge multiplier, the flat skill cap holds
        vm.prank(escrowRole);
        vm.expectRevert(abi.encodeWithSelector(FobalProgression.PolicyViolated.selector, p1, "skill delta"));
        progression.applyMatch(keccak256("m"), list, 100_000);
    }

    function test_totalPointsCap() public {
        FobalTypes.ProgressionDelta memory d;
        // 3 skills x +2 = 6 > default maxPointsPerMatch 5
        d.skillDeltas = PlayerCodec.setSkill(0, 0, 2);
        d.skillDeltas = PlayerCodec.setSkill(d.skillDeltas, 1, 2);
        d.skillDeltas = PlayerCodec.setSkill(d.skillDeltas, 2, 2);
        FobalTypes.PlayerProgress[] memory list = _one(p1, d);
        vm.prank(escrowRole);
        vm.expectRevert(abi.encodeWithSelector(FobalProgression.PolicyViolated.selector, p1, "points"));
        progression.applyMatch(keccak256("m"), list, 10_000);
    }

    function test_setPolicy_boundedByHardCaps() public {
        FobalProgression.Policy memory p = FobalProgression.Policy({
            maxXpPerMatch: 10_001, // > HARD_MAX_XP
            maxDeltaPerSkill: 2,
            maxPointsPerMatch: 5,
            maxGoalsPerPlayer: 10,
            maxAssistsPerPlayer: 10
        });
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FobalProgression.PolicyOutOfBounds.selector, "xp"));
        progression.setPolicy(p);
    }

    function test_careerCountersMonotonic() public {
        FobalTypes.PlayerProgress[] memory list = _one(p1, defaultProgress(p1, 1).delta);
        vm.startPrank(escrowRole);
        progression.applyMatch(keccak256("a"), list, 10_000);
        progression.applyMatch(keccak256("b"), list, 10_000);
        vm.stopPrank();
        FobalTypes.CareerStats memory s = player.statsOf(p1);
        assertEq(s.matchesPlayed, 2);
        assertEq(s.wins, 2);
        assertEq(s.goals, 4);
    }
}
