// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFobalPlayer, FobalTypes} from "./interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "./libraries/PlayerCodec.sol";

/// @title FobalProgression — engine discretion, protocol policy.
/// @notice The engine decides WHAT happened (it signed it); this contract
/// decides what is ALLOWED. Policy caps are versioned configuration bounded
/// by hard protocol limits; FobalPlayer then independently re-enforces its
/// own invariants (skills <= 100, monotonic counters, untouchable identity).
/// Two layers stand between a compromised engine key and player state.
contract FobalProgression is AccessControl, ReentrancyGuard {
    bytes32 public constant ESCROW_ROLE = keccak256("ESCROW_ROLE");

    /// @dev Hard ceilings the admin-tunable policy can never exceed.
    uint32 public constant HARD_MAX_XP = 10_000;
    uint8 public constant HARD_MAX_SKILL_DELTA = 10;
    uint16 public constant HARD_MAX_POINTS = 40;
    uint16 public constant HARD_MAX_COUNT = 50;

    struct Policy {
        uint32 maxXpPerMatch; // scaled by the asset's progressionMultiplierBps
        uint8 maxDeltaPerSkill; // flat — money never buys bigger jumps
        uint16 maxPointsPerMatch; // flat cap on total skill points gained
        uint16 maxGoalsPerPlayer;
        uint16 maxAssistsPerPlayer;
    }

    IFobalPlayer public immutable player;
    Policy public policy = Policy({
        maxXpPerMatch: 200,
        maxDeltaPerSkill: 2,
        maxPointsPerMatch: 5,
        maxGoalsPerPlayer: 10,
        maxAssistsPerPlayer: 10
    });

    /// @notice Progression can be consumed exactly once per (match, player).
    mapping(bytes32 matchId => mapping(uint256 playerId => bool)) public consumed;

    event ProgressionApplied(bytes32 indexed matchId, uint256 indexed playerId, uint32 xp, uint8 result);
    event PolicyChanged(Policy policy);

    error AlreadyProgressed(bytes32 matchId, uint256 playerId);
    error PolicyViolated(uint256 playerId, string reason);
    error PolicyOutOfBounds(string reason);

    constructor(IFobalPlayer playerContract, address admin) {
        player = playerContract;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Apply one settled match's progression. Only the escrow may
    /// call, and only with data whose hash the engine signed.
    /// @param multiplierBps The staked asset's progression multiplier
    /// (10_000 = 1x). Scales the XP ceiling only — skill caps stay flat so
    /// paying more can never buy bigger per-match jumps.
    function applyMatch(bytes32 matchId, FobalTypes.PlayerProgress[] calldata list, uint32 multiplierBps)
        external
        onlyRole(ESCROW_ROLE)
        nonReentrant
    {
        Policy memory p = policy;
        uint256 xpCap = (uint256(p.maxXpPerMatch) * multiplierBps) / 10_000;
        for (uint256 i; i < list.length; ++i) {
            FobalTypes.PlayerProgress calldata entry = list[i];
            if (consumed[matchId][entry.playerId]) revert AlreadyProgressed(matchId, entry.playerId);
            consumed[matchId][entry.playerId] = true;

            FobalTypes.ProgressionDelta calldata d = entry.delta;
            if (d.xp > xpCap) revert PolicyViolated(entry.playerId, "xp");
            if (d.goals > p.maxGoalsPerPlayer) revert PolicyViolated(entry.playerId, "goals");
            if (d.assists > p.maxAssistsPerPlayer) revert PolicyViolated(entry.playerId, "assists");

            uint256 totalPoints;
            for (uint256 lane; lane < PlayerCodec.SKILL_COUNT; ++lane) {
                uint8 delta = uint8(d.skillDeltas >> (lane * 8));
                if (delta > p.maxDeltaPerSkill) revert PolicyViolated(entry.playerId, "skill delta");
                totalPoints += delta;
            }
            if (totalPoints > p.maxPointsPerMatch) revert PolicyViolated(entry.playerId, "points");

            player.applyProgression(entry.playerId, d);
            emit ProgressionApplied(matchId, entry.playerId, d.xp, d.result);
        }
    }

    function setPolicy(Policy calldata newPolicy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPolicy.maxXpPerMatch > HARD_MAX_XP) revert PolicyOutOfBounds("xp");
        if (newPolicy.maxDeltaPerSkill > HARD_MAX_SKILL_DELTA) revert PolicyOutOfBounds("delta");
        if (newPolicy.maxPointsPerMatch > HARD_MAX_POINTS) revert PolicyOutOfBounds("points");
        if (newPolicy.maxGoalsPerPlayer > HARD_MAX_COUNT) revert PolicyOutOfBounds("goals");
        if (newPolicy.maxAssistsPerPlayer > HARD_MAX_COUNT) revert PolicyOutOfBounds("assists");
        policy = newPolicy;
        emit PolicyChanged(newPolicy);
    }
}
