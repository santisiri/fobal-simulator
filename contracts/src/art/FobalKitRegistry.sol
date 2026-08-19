// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ITeamsRead} from "./FobalSquadRegistry.sol";

/// @title FobalKitRegistry — a club's colours, as first-class state.
/// @notice Four kits per team (home, away, third, goalkeeper), each three
/// packed uint24 colours plus a pattern. Configured by the TEAM OWNER, read
/// by the renderer.
///
/// NOTHING IS EVER BLANK. A team that has never configured a kit still gets
/// one, derived deterministically from its own teamDna — so kits need no
/// coordinated flag day and no migration: clubs adopt them whenever they like
/// and look like a club in the meantime.
///
/// Every read on the render path is total. A kit for an unknown team, an
/// out-of-range slot, or a team whose registry entry is empty all resolve to
/// something drawable rather than reverting.
contract FobalKitRegistry {
    struct Kit {
        uint24 primary;
        uint24 secondary;
        uint24 accent;
        uint8 pattern; // 0 solid, 1 sleeves, 2 stripes, 3 hoops, 4 halves, 5 sash, 6 chevron
        bool set;
    }

    uint8 public constant HOME = 0;
    uint8 public constant AWAY = 1;
    uint8 public constant THIRD = 2;
    uint8 public constant KEEPER = 3;
    uint8 public constant SLOTS = 4;
    uint8 public constant PATTERNS = 7;

    ITeamsRead public immutable teams;

    mapping(uint64 teamId => mapping(uint8 slot => Kit)) private _kits;
    /// @notice which slot a club is currently wearing (home unless changed)
    mapping(uint64 teamId => uint8) public activeSlot;

    event KitSet(uint64 indexed teamId, uint8 indexed slot, uint24 primary, uint24 secondary, uint24 accent, uint8 pattern);
    event ActiveKitSet(uint64 indexed teamId, uint8 indexed slot);

    error NotTeamOwner(uint64 teamId);
    error BadSlot(uint8 slot);
    error BadPattern(uint8 pattern);

    constructor(ITeamsRead teamRegistry) {
        teams = teamRegistry;
    }

    function _requireTeamOwner(uint64 teamId) private view {
        (address owner,,,) = teams.teams(teamId);
        if (owner == address(0) || owner != msg.sender) revert NotTeamOwner(teamId);
    }

    function setKit(uint64 teamId, uint8 slot, uint24 primary, uint24 secondary, uint24 accent, uint8 pattern)
        external
    {
        _requireTeamOwner(teamId);
        if (slot >= SLOTS) revert BadSlot(slot);
        if (pattern >= PATTERNS) revert BadPattern(pattern);
        _kits[teamId][slot] = Kit(primary, secondary, accent, pattern, true);
        emit KitSet(teamId, slot, primary, secondary, accent, pattern);
    }

    function setActiveKit(uint64 teamId, uint8 slot) external {
        _requireTeamOwner(teamId);
        if (slot >= SLOTS) revert BadSlot(slot);
        activeSlot[teamId] = slot;
        emit ActiveKitSet(teamId, slot);
    }

    function kitAt(uint64 teamId, uint8 slot) external view returns (Kit memory) {
        return _kits[teamId][slot];
    }

    /// @notice A club that has configured nothing still has colours: derive
    /// them from its own dna so every team is visually distinct from day one.
    function defaultKit(bytes32 teamDna, uint8 slot) public pure returns (Kit memory k) {
        uint256 h = uint256(keccak256(abi.encodePacked(teamDna, slot)));
        k.primary = uint24(h);
        k.secondary = uint24(h >> 32);
        k.accent = uint24(h >> 64);
        k.pattern = uint8((h >> 96) % PATTERNS);
        k.set = false;
    }

    /// @notice THE RENDER-PATH READ. Total by construction: unknown teams,
    /// empty registry entries and unset kits all resolve to something
    /// drawable. Goalkeepers wear the keeper slot regardless of the club's
    /// active choice.
    function kitFor(uint64 teamId, uint8 position) external view returns (Kit memory) {
        uint8 slot = position == 0 ? KEEPER : activeSlot[teamId];
        if (slot >= SLOTS) slot = HOME;
        Kit memory k = _kits[teamId][slot];
        if (k.set) return k;
        // fall back to the club's configured home kit before inventing one
        if (slot != HOME) {
            Kit memory home = _kits[teamId][HOME];
            if (home.set && position != 0) return home;
        }
        (,, bytes32 dna,) = teams.teams(teamId);
        return defaultKit(dna, slot);
    }
}
