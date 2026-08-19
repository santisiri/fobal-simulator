// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IFobalRenderer} from "../interfaces/IFobalRenderer.sol";
import {FobalTypes} from "../interfaces/IFobalPlayer.sol";
import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {FobalTraitEngine as TE} from "./FobalTraitEngine.sol";
import {FobalFaceComposer} from "./FobalFaceComposer.sol";
import {FobalKitComposer} from "./FobalKitComposer.sol";
import {FobalSquadRegistry} from "./FobalSquadRegistry.sol";
import {FobalKitRegistry} from "./FobalKitRegistry.sol";
import {SvgNum} from "./SvgNum.sol";

interface IPlayerReader2 {
    function playerView(uint256 tokenId) external view returns (FobalTypes.PlayerView memory);
}

/// @title FobalRendererV2_1 — identity from the token, kit from the club.
/// @notice The face comes from (dna, appearance), which are immutable. The
/// jersey comes from the squad registry and the club's kit registry, which
/// are not. A player who moves clubs changes shirt and keeps their face; a
/// player who is sold keeps BOTH until someone explicitly moves them, because
/// squad membership is state, not a side effect of ownership.
///
/// Every lookup on this path degrades instead of reverting: an unassigned
/// player wears the free-agent kit, an unconfigured club wears a kit derived
/// from its own dna, and a registry that is missing entirely falls back to
/// the free agent. There is no input for which tokenURI fails.
contract FobalRendererV2_1 is IFobalRenderer {
    IPlayerReader2 public immutable player;
    FobalFaceComposer public immutable faces;
    FobalKitComposer public immutable kits;
    FobalSquadRegistry public immutable squads;
    FobalKitRegistry public immutable wardrobe;

    constructor(
        IPlayerReader2 playerContract,
        FobalFaceComposer faceComposer,
        FobalKitComposer kitComposer,
        FobalSquadRegistry squadRegistry,
        FobalKitRegistry kitRegistry
    ) {
        player = playerContract;
        faces = faceComposer;
        kits = kitComposer;
        squads = squadRegistry;
        wardrobe = kitRegistry;
    }

    function version() external pure returns (string memory) {
        return "avatar-v2.1-kits";
    }

    function _c(bytes memory table, uint256 index) private pure returns (bytes3) {
        uint256 o = index * 3;
        if (o + 3 > table.length) o = 0;
        return bytes3(bytes.concat(table[o], table[o + 1], table[o + 2]));
    }

    function paletteFor(TE.Traits memory t, FobalKitComposer.Kit memory kit)
        public
        pure
        returns (bytes3[12] memory pal)
    {
        pal[0] = K.INK;
        pal[1] = _c(K.SKIN_BASE, t.skin);
        pal[2] = _c(K.SKIN_SHADE, t.skin);
        pal[3] = _c(K.SKIN_LIGHT, t.skin);
        pal[4] = _c(K.HAIR_COLOR, t.hairColor);
        pal[5] = _c(K.HAIR_COLOR, t.hairColor >= 2 ? t.hairColor - 2 : 0);
        pal[6] = K.EYE_WHITE;
        pal[7] = _c(K.IRIS_COLOR, t.iris);
        pal[8] = _c(K.ACCENT_COLOR, t.accent);
        pal[9] = bytes3(kit.primary);
        pal[10] = bytes3(kit.secondary);
        pal[11] = bytes3(kit.accent);
    }

    /// @notice A player with no club still looks like a footballer.
    function freeAgentKit(bytes32 s0) public pure returns (FobalKitComposer.Kit memory k) {
        k.primary = uint24(bytes3(_c(K.ACCENT_COLOR, TE.lane(s0, "KIT1") % 8)));
        k.secondary = uint24(bytes3(_c(K.ACCENT_COLOR, TE.lane(s0, "KIT2") % 8)));
        k.accent = uint24(bytes3(_c(K.ACCENT_COLOR, TE.lane(s0, "KIT3") % 8)));
        k.pattern = uint8(TE.lane(s0, "KITP") % 7);
    }

    /// @notice What this token wears right now, and why — exposed so a client
    /// can explain a jersey without replaying the whole fallback chain.
    function kitOf(uint256 tokenId, bytes32 s0, uint8 position)
        public
        view
        returns (FobalKitComposer.Kit memory kit, uint64 teamId, bool clubKit)
    {
        if (address(squads) == address(0) || address(wardrobe) == address(0)) {
            return (freeAgentKit(s0), 0, false);
        }
        try squads.teamOfSafe(tokenId) returns (uint64 team) {
            teamId = team;
        } catch {
            return (freeAgentKit(s0), 0, false);
        }
        if (teamId == 0) return (freeAgentKit(s0), 0, false);
        try wardrobe.kitFor(teamId, position) returns (FobalKitRegistry.Kit memory k) {
            return (FobalKitComposer.Kit(k.primary, k.secondary, k.accent, k.pattern), teamId, true);
        } catch {
            return (freeAgentKit(s0), teamId, false);
        }
    }

    function _r(int256 x, int256 y, uint256 w, uint256 h, bytes3 fill) private pure returns (string memory) {
        return string.concat(
            '<rect x="', SvgNum.i(x), '" y="', SvgNum.i(y),
            '" width="', SvgNum.u(w), '" height="', SvgNum.u(h),
            '" fill="#', SvgNum.color(fill), '"/>'
        );
    }

    /// @notice The parity entry point: identity plus an explicit kit, with no
    /// registry involved, so the reference renderer and the chain can be
    /// compared byte for byte.
    function imageWithKit(bytes32 dna, uint256 appearance, FobalKitComposer.Kit memory kit)
        public
        view
        returns (string memory)
    {
        TE.Traits memory t = TE.traitsOf(TE.seedOf(dna, appearance));
        bytes3[12] memory pal = paletteFor(t, kit);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges" width="100%" height="100%">',
            _r(0, 0, 32, 32, _c(K.BG_COLOR, t.bg)),
            kits.kitLayer(kit, pal[8]),
            _r(13, 21, 6, 3, pal[2]),
            faces.identity(t, pal),
            "</svg>"
        );
    }

    function imageOf(uint256 tokenId, bytes32 dna, uint256 appearance, uint8 position)
        public
        view
        returns (string memory)
    {
        bytes32 s0 = TE.seedOf(dna, appearance);
        (FobalKitComposer.Kit memory kit,,) = kitOf(tokenId, s0, position);
        return imageWithKit(dna, appearance, kit);
    }

    /// @notice The face alone, independent of any club. A transfer or a
    /// kit change must never move this value — asserted in the tests.
    function faceHash(bytes32 dna, uint256 appearance) external pure returns (bytes32) {
        TE.Traits memory t = TE.traitsOf(TE.seedOf(dna, appearance));
        return keccak256(
            abi.encode(t.head, t.skin, t.eyes, t.brows, t.nose, t.mouth, t.hair, t.hairColor, t.beard, t.headwear)
        );
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        bytes32 s0 = TE.seedOf(v.dna, v.appearance);
        (FobalKitComposer.Kit memory kit, uint64 teamId, bool clubKit) = kitOf(tokenId, s0, v.core.position);
        string memory image = imageWithKit(v.dna, v.appearance, kit);
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(
                bytes(
                    string.concat(
                        '{"name":"',
                        v.name,
                        '","description":"An on-chain FOBAL footballer.","image":"data:image/svg+xml;base64,',
                        Base64.encode(bytes(image)),
                        '","attributes":',
                        _attributes(v, teamId, clubKit),
                        "}"
                    )
                )
            )
        );
    }

    function _attributes(FobalTypes.PlayerView memory v, uint64 teamId, bool clubKit)
        private
        pure
        returns (string memory)
    {
        TE.Traits memory t = TE.traitsOf(TE.seedOf(v.dna, v.appearance));
        return string.concat(
            '[{"trait_type":"Position","value":"',
            _position(v.core.position),
            '"},{"trait_type":"Club","value":"',
            teamId == 0 ? "Free Agent" : string.concat("Team #", SvgNum.u(teamId)),
            '"},{"trait_type":"Kit","value":"',
            clubKit ? "Club" : "Free Agent",
            '"},{"trait_type":"Level","value":',
            SvgNum.u(v.core.level),
            '},{"trait_type":"XP","value":',
            SvgNum.u(v.core.xp),
            '},{"trait_type":"Goals","value":',
            SvgNum.u(v.stats.goals),
            '},{"trait_type":"Hair","value":',
            SvgNum.u(t.hair),
            '},{"trait_type":"Facial Hair","value":',
            SvgNum.u(t.beard),
            '},{"trait_type":"Headwear","value":',
            SvgNum.u(t.headwear),
            "}]"
        );
    }

    function _position(uint8 p) private pure returns (string memory) {
        if (p == 0) return "GK";
        if (p == 1) return "DF";
        if (p == 2) return "MF";
        return "FW";
    }
}
