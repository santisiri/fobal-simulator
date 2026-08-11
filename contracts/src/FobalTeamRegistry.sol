// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FobalTeamRegistry — team identity, never custody.
/// @notice A team is a logical identity: an id, an owner, a name, a visual
/// dna, a birthday. Player NFTs are NEVER custodied here; roster membership
/// is expressed through RosterUpdated events and validated where it matters
/// (the escrow checks live ERC-721 ownership at match entry). Selling a
/// player breaks nothing: historical lineups live in indexed events, current
/// control is always the ERC-721 owner.
contract FobalTeamRegistry {
    struct Team {
        address owner;
        uint40 createdAt;
        bytes32 teamDna;
        string name;
    }

    uint64 public nextTeamId = 1;
    mapping(uint64 teamId => Team) public teams;

    event TeamCreated(uint64 indexed teamId, address indexed owner, string name, bytes32 teamDna);
    event TeamTransferred(uint64 indexed teamId, address indexed previousOwner, address indexed newOwner);
    event RosterUpdated(uint64 indexed teamId, address indexed owner, uint256[] playerIds);

    error TeamNameInvalid();
    error NotTeamOwner(uint64 teamId);
    error TeamDoesNotExist(uint64 teamId);

    function createTeam(string calldata name, bytes32 teamDna) external returns (uint64 teamId) {
        bytes memory n = bytes(name);
        if (n.length == 0 || n.length > 32) revert TeamNameInvalid();
        teamId = nextTeamId++;
        teams[teamId] =
            Team({owner: msg.sender, createdAt: uint40(block.timestamp), teamDna: teamDna, name: name});
        emit TeamCreated(teamId, msg.sender, name, teamDna);
    }

    function transferTeam(uint64 teamId, address newOwner) external {
        Team storage team = _team(teamId);
        if (team.owner != msg.sender) revert NotTeamOwner(teamId);
        emit TeamTransferred(teamId, team.owner, newOwner);
        team.owner = newOwner;
    }

    /// @notice Declare the team's current roster. Purely informational — the
    /// canonical control check is ERC-721 ownership at match entry. Emitting
    /// keeps the indexer's roster view fresh without fragile on-chain sync.
    function declareRoster(uint64 teamId, uint256[] calldata playerIds) external {
        Team storage team = _team(teamId);
        if (team.owner != msg.sender) revert NotTeamOwner(teamId);
        emit RosterUpdated(teamId, msg.sender, playerIds);
    }

    function ownerOfTeam(uint64 teamId) external view returns (address) {
        return _team(teamId).owner;
    }

    function _team(uint64 teamId) internal view returns (Team storage team) {
        team = teams[teamId];
        if (team.owner == address(0)) revert TeamDoesNotExist(teamId);
    }
}
