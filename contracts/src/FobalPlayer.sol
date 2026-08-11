// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {FobalTypes} from "./interfaces/IFobalPlayer.sol";
import {IFobalRenderer} from "./interfaces/IFobalRenderer.sol";
import {PlayerCodec} from "./libraries/PlayerCodec.sol";
import {ProgressionMath} from "./libraries/ProgressionMath.sol";

/// @title FobalPlayer — the canonical, persistent footballer collection.
/// @notice The smallest and most conservative contract in the protocol.
/// Ownership is plain ERC-721. Canonical state is the minimum needed to
/// reconstruct the footballer: core, dna, skills, appearance, career, name.
/// DNA, appearance and name are immutable after mint — no role can rewrite
/// identity. Deliberately NOT upgradeable: the collection outliving every
/// other module is the product.
///
/// Privileged surfaces are narrow and role-scoped:
///  - MINTER_ROLE       (FobalPlayerGenerator)  mint only
///  - PROGRESSION_ROLE  (FobalProgression)      bounded stat evolution only
///  - LOCK_ROLE         (FobalMatchEscrow)      transfer locks only
///  - DEFAULT_ADMIN     (governance multisig)   renderer + role admin
contract FobalPlayer is ERC721, AccessControl, IERC4906 {
    using PlayerCodec for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PROGRESSION_ROLE = keccak256("PROGRESSION_ROLE");
    bytes32 public constant LOCK_ROLE = keccak256("LOCK_ROLE");

    uint8 public constant POSITION_GK = 0;
    uint8 public constant POSITION_FW = 3;
    uint8 public constant SKILL_SCHEMA_V1 = 1;

    uint256 public nextTokenId = 1;
    IFobalRenderer public renderer;

    mapping(uint256 tokenId => FobalTypes.PlayerCore) internal _core;
    mapping(uint256 tokenId => FobalTypes.CareerStats) internal _stats;
    mapping(uint256 tokenId => bytes32) public dnaOf;
    mapping(uint256 tokenId => uint256) public skillsOf;
    mapping(uint256 tokenId => uint256) public appearanceOf;
    mapping(uint256 tokenId => string) public nameOf;
    /// @notice Zero address when free; the locking contract's address when
    /// committed to an active match. Only the locker can unlock.
    mapping(uint256 tokenId => address) public lockedBy;

    event PlayerMinted(
        uint256 indexed tokenId, address indexed owner, uint32 generation, uint8 position, bytes32 dna
    );
    event PlayerProgressed(
        uint256 indexed tokenId, uint32 xpGained, uint16 newLevel, uint256 newSkills, uint8 result
    );
    event PlayerLocked(uint256 indexed tokenId, address indexed locker);
    event PlayerUnlocked(uint256 indexed tokenId, address indexed locker);
    event RendererChanged(address indexed renderer, string version);

    error InvalidSeed(string reason);
    error InvalidDelta(string reason);
    error PlayerIsLocked(uint256 tokenId);
    error NotLocker(uint256 tokenId);
    error AlreadyLocked(uint256 tokenId);
    error NotLocked(uint256 tokenId);
    error RendererUnset();

    constructor(address admin) ERC721("Fobal Player", "FOBAL") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ mint

    function mint(address to, FobalTypes.PlayerSeed calldata seed)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 tokenId)
    {
        bytes memory nameBytes = bytes(seed.name);
        if (nameBytes.length == 0 || nameBytes.length > 32) revert InvalidSeed("name length");
        if (seed.position > POSITION_FW) revert InvalidSeed("position");
        if (!seed.skills.validSkills()) revert InvalidSeed("skills");
        if (!seed.appearance.validAppearance()) revert InvalidSeed("appearance");
        if (seed.dna == bytes32(0)) revert InvalidSeed("dna");

        tokenId = nextTokenId++;
        _core[tokenId] = FobalTypes.PlayerCore({
            generation: seed.generation,
            xp: 0,
            level: 1,
            country: seed.country,
            position: seed.position,
            skillSchema: SKILL_SCHEMA_V1
        });
        dnaOf[tokenId] = seed.dna;
        skillsOf[tokenId] = seed.skills;
        appearanceOf[tokenId] = seed.appearance;
        nameOf[tokenId] = seed.name;

        _safeMint(to, tokenId);
        emit PlayerMinted(tokenId, to, seed.generation, seed.position, seed.dna);
    }

    // ----------------------------------------------------------- progression

    /// @notice Bounded evolution. This is the LAST line of defense: whatever
    /// policy the progression module applies, this function independently
    /// guarantees skills stay in 0..100, counters only grow, exactly one
    /// match is recorded per call, and identity (dna/appearance/name) is
    /// untouchable — it simply has no code path that writes them.
    function applyProgression(uint256 tokenId, FobalTypes.ProgressionDelta calldata delta)
        external
        onlyRole(PROGRESSION_ROLE)
    {
        _requireOwned(tokenId);
        if (delta.result > 2) revert InvalidDelta("result");
        if (delta.skillDeltas & ~PlayerCodec.SKILLS_MASK != 0) revert InvalidDelta("delta bits");

        uint256 skills = skillsOf[tokenId];
        for (uint256 i; i < PlayerCodec.SKILL_COUNT; ++i) {
            uint8 d = uint8(delta.skillDeltas >> (i * 8));
            if (d == 0) continue;
            uint256 next = uint256(skills.skill(i)) + d;
            if (next > PlayerCodec.SKILL_MAX) revert InvalidDelta("skill cap");
            skills = skills.setSkill(i, uint8(next));
        }
        skillsOf[tokenId] = skills;

        FobalTypes.PlayerCore storage core = _core[tokenId];
        core.xp += delta.xp; // 0.8 checked math: overflow reverts
        core.level = ProgressionMath.levelForXp(core.xp);

        FobalTypes.CareerStats storage stats = _stats[tokenId];
        stats.matchesPlayed += 1;
        if (delta.result == 1) stats.wins += 1;
        else if (delta.result == 2) stats.losses += 1;
        else stats.draws += 1;
        stats.goals += delta.goals;
        stats.assists += delta.assists;
        if (delta.cleanSheet) stats.cleanSheets += 1;

        emit PlayerProgressed(tokenId, delta.xp, core.level, skills, delta.result);
        emit MetadataUpdate(tokenId);
    }

    // ----------------------------------------------------------------- locks

    function lock(uint256 tokenId) external onlyRole(LOCK_ROLE) {
        _requireOwned(tokenId);
        if (lockedBy[tokenId] != address(0)) revert AlreadyLocked(tokenId);
        lockedBy[tokenId] = msg.sender;
        emit PlayerLocked(tokenId, msg.sender);
    }

    function unlock(uint256 tokenId) external {
        address locker = lockedBy[tokenId];
        if (locker == address(0)) revert NotLocked(tokenId);
        if (locker != msg.sender) revert NotLocker(tokenId);
        lockedBy[tokenId] = address(0);
        emit PlayerUnlocked(tokenId, msg.sender);
    }

    /// @dev Transfers (but not mints) are blocked while locked.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && lockedBy[tokenId] != address(0)) revert PlayerIsLocked(tokenId);
        return super._update(to, tokenId, auth);
    }

    // -------------------------------------------------------------- metadata

    function setRenderer(IFobalRenderer newRenderer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        renderer = newRenderer;
        emit RendererChanged(address(newRenderer), newRenderer.version());
        if (nextTokenId > 1) emit BatchMetadataUpdate(1, nextTokenId - 1);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (address(renderer) == address(0)) revert RendererUnset();
        return renderer.tokenURI(tokenId);
    }

    function playerView(uint256 tokenId) external view returns (FobalTypes.PlayerView memory v) {
        address owner = _requireOwned(tokenId);
        v = FobalTypes.PlayerView({
            core: _core[tokenId],
            stats: _stats[tokenId],
            dna: dnaOf[tokenId],
            skills: skillsOf[tokenId],
            appearance: appearanceOf[tokenId],
            name: nameOf[tokenId],
            owner: owner,
            lockedBy: lockedBy[tokenId]
        });
    }

    function coreOf(uint256 tokenId) external view returns (FobalTypes.PlayerCore memory) {
        _requireOwned(tokenId);
        return _core[tokenId];
    }

    function statsOf(uint256 tokenId) external view returns (FobalTypes.CareerStats memory) {
        _requireOwned(tokenId);
        return _stats[tokenId];
    }

    // ------------------------------------------------------------------ misc

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl, IERC165)
        returns (bool)
    {
        // 0x49064906 is the ERC-4906 interface id per the EIP.
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }
}
