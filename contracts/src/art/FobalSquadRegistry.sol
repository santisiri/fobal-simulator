// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IOwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface ITeamsRead {
    /// @dev the AUTO-GETTER, not ownerOfTeam(): the getter returns zeros for
    /// an unknown id, while ownerOfTeam REVERTS — and anything on the render
    /// path that can revert takes tokenURI down for that token.
    function teams(uint64 teamId) external view returns (address owner, uint40 createdAt, bytes32 teamDna, string memory name);
}

/// @title FobalSquadRegistry — the player-to-team link that did not exist.
/// @notice Before this, nothing on chain could answer "what club is this
/// player at?": FobalTeamRegistry only EMITS rosters and is imported by no
/// contract. This is the smallest possible state that makes a jersey
/// renderable, and it is deliberately separate from ownership.
///
/// WHY teamId AND NOT owner. Binding a kit to the current owner would mean a
/// sale silently repaints the art, and worse, that the correct art depends on
/// state the renderer cannot refresh for tokens it does not know about.
/// Squad membership is therefore EXPLICIT: a sale moves the token, and the
/// player keeps wearing their club's shirt until someone transacts to change
/// that — exactly like real football, where a transfer is an event, not a
/// side effect.
///
/// ASYMMETRIC AUTHORITY. Only the NFT owner may JOIN a team (nobody can
/// conscript your player), but EITHER the NFT owner or the team owner may
/// RELEASE (neither party can hold the other hostage).
contract FobalSquadRegistry {
    IOwnerOf public immutable player;
    ITeamsRead public immutable teams;

    mapping(uint256 tokenId => uint64) public teamOf;

    event PlayerJoined(uint256 indexed tokenId, uint64 indexed teamId, address indexed by);
    event PlayerReleased(uint256 indexed tokenId, uint64 indexed teamId, address indexed by);

    error NotPlayerOwner(uint256 tokenId);
    error NotAuthorised(uint256 tokenId);
    error NoSuchTeam(uint64 teamId);
    error AlreadyThere(uint256 tokenId, uint64 teamId);

    constructor(IOwnerOf playerContract, ITeamsRead teamRegistry) {
        player = playerContract;
        teams = teamRegistry;
    }

    function join(uint256 tokenId, uint64 teamId) public {
        if (player.ownerOf(tokenId) != msg.sender) revert NotPlayerOwner(tokenId);
        (address teamOwner,,,) = teams.teams(teamId);
        if (teamOwner == address(0)) revert NoSuchTeam(teamId);

        uint64 previous = teamOf[tokenId];
        if (previous == teamId) revert AlreadyThere(tokenId, teamId);
        // a move is a release AND a join, so indexers never have to infer the
        // departure from a later arrival
        if (previous != 0) emit PlayerReleased(tokenId, previous, msg.sender);
        teamOf[tokenId] = teamId;
        emit PlayerJoined(tokenId, teamId, msg.sender);
    }

    function joinBatch(uint256[] calldata tokenIds, uint64 teamId) external {
        for (uint256 i; i < tokenIds.length; ++i) {
            join(tokenIds[i], teamId);
        }
    }

    function release(uint256 tokenId) external {
        uint64 current = teamOf[tokenId];
        if (current == 0) revert NotAuthorised(tokenId);
        (address teamOwner,,,) = teams.teams(current);
        if (msg.sender != player.ownerOf(tokenId) && msg.sender != teamOwner) revert NotAuthorised(tokenId);
        delete teamOf[tokenId];
        emit PlayerReleased(tokenId, current, msg.sender);
    }

    /// @notice Render-path read: NEVER reverts, for any input.
    function teamOfSafe(uint256 tokenId) external view returns (uint64) {
        return teamOf[tokenId];
    }
}
