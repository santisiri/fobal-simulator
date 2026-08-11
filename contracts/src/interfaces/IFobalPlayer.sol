// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Shared canonical types for the Fobal player collection.
library FobalTypes {
    /// @dev One storage slot. 14 bytes spare for future schema evolution.
    struct PlayerCore {
        uint32 generation;
        uint32 xp;
        uint16 level;
        uint16 country; // ISO 3166-1 numeric
        uint8 position; // 0 GK, 1 DF, 2 MF, 3 FW
        uint8 skillSchema; // 1 = the 12-skill layout in PlayerCodec
    }

    /// @dev One storage slot: 7 x uint32 monotonic counters.
    struct CareerStats {
        uint32 matchesPlayed;
        uint32 wins;
        uint32 draws;
        uint32 losses;
        uint32 goals;
        uint32 assists;
        uint32 cleanSheets;
    }

    /// @notice Mint-time identity. DNA and appearance are immutable forever.
    struct PlayerSeed {
        string name;
        bytes32 dna;
        uint256 skills; // packed, schema 1
        uint256 appearance; // packed visual traits
        uint32 generation;
        uint16 country;
        uint8 position;
    }

    /// @notice A single match's worth of progression for one player.
    /// All deltas are non-negative; the match result updates exactly one of
    /// wins/draws/losses; matchesPlayed increments by exactly one per apply.
    struct ProgressionDelta {
        uint32 xp;
        uint256 skillDeltas; // packed like skills; each lane is a delta
        uint8 result; // 0 draw, 1 win, 2 loss
        uint16 goals;
        uint16 assists;
        bool cleanSheet;
    }

    /// @notice One player's progression inside a settled match. The array of
    /// these is hashed into the signed MatchResult (progressionHash), so the
    /// engine signs result AND progression with one signature.
    struct PlayerProgress {
        uint256 playerId;
        ProgressionDelta delta;
    }

    /// @notice Flat read model for renderers and clients.
    struct PlayerView {
        PlayerCore core;
        CareerStats stats;
        bytes32 dna;
        uint256 skills;
        uint256 appearance;
        string name;
        address owner;
        address lockedBy;
    }
}

interface IFobalPlayer {
    function mint(address to, FobalTypes.PlayerSeed calldata seed) external returns (uint256 tokenId);
    function applyProgression(uint256 tokenId, FobalTypes.ProgressionDelta calldata delta) external;
    function lock(uint256 tokenId) external;
    function unlock(uint256 tokenId) external;
    function lockedBy(uint256 tokenId) external view returns (address);
    function playerView(uint256 tokenId) external view returns (FobalTypes.PlayerView memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
