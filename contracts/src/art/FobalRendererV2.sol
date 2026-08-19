// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IFobalRenderer} from "../interfaces/IFobalRenderer.sol";
import {FobalTypes} from "../interfaces/IFobalPlayer.sol";
import {FobalArtConstants as K} from "./FobalArtConstants.sol";
import {FobalTraitEngine as TE} from "./FobalTraitEngine.sol";
import {FobalFaceComposer} from "./FobalFaceComposer.sol";
import {SvgNum} from "./SvgNum.sol";

interface IPlayerReader {
    function playerView(uint256 tokenId) external view returns (FobalTypes.PlayerView memory);
}

/// @title FobalRendererV2 — the P3 renderer, FACE ONLY.
/// @notice Reads (dna, appearance) from the collection, derives a TraitVector,
/// and composes a 32x32 bust. Players render as FREE AGENTS: the kit comes
/// from the seed, so this renderer performs no team lookup and can be proven
/// standalone before any registry exists. P4 swaps the kit source; the face
/// is untouched, which is the point of composing them separately.
///
/// Parity with packages/art (the reference renderer) is asserted byte-for-byte
/// over a fixture seed set in test/unit/RendererV2Parity.t.sol.
contract FobalRendererV2 is IFobalRenderer {
    IPlayerReader public immutable player;
    FobalFaceComposer public immutable faces;

    constructor(IPlayerReader playerContract, FobalFaceComposer composer) {
        player = playerContract;
        faces = composer;
    }

    function version() external pure returns (string memory) {
        return "avatar-v2-face";
    }

    // ------------------------------------------------------------- palette

    function _c(bytes memory table, uint256 index) private pure returns (bytes3 out) {
        uint256 o = index * 3;
        if (o + 2 >= table.length + 1) o = 0;
        return bytes3(bytes.concat(table[o], table[o + 1], table[o + 2]));
    }

    function paletteFor(TE.Traits memory t, Kit memory kit) public pure returns (bytes3[12] memory pal) {
        pal[0] = K.INK;
        pal[1] = _c(K.SKIN_BASE, t.skin);
        pal[2] = _c(K.SKIN_SHADE, t.skin);
        pal[3] = _c(K.SKIN_LIGHT, t.skin);
        pal[4] = _c(K.HAIR_COLOR, t.hairColor);
        pal[5] = _c(K.HAIR_COLOR, t.hairColor >= 2 ? t.hairColor - 2 : 0);
        pal[6] = K.EYE_WHITE;
        pal[7] = _c(K.IRIS_COLOR, t.iris);
        pal[8] = _c(K.ACCENT_COLOR, t.accent);
        pal[9] = kit.primary;
        pal[10] = kit.secondary;
        pal[11] = kit.accent;
    }

    // ----------------------------------------------------------------- kit

    struct Kit {
        bytes3 primary;
        bytes3 secondary;
        bytes3 accent;
        uint8 pattern;
    }

    /// @notice P3's kit source: the seed itself. No registry, no team.
    function freeAgentKit(bytes32 s0) public pure returns (Kit memory k) {
        k.primary = _c(K.ACCENT_COLOR, TE.lane(s0, "KIT1") % 8);
        k.secondary = _c(K.ACCENT_COLOR, TE.lane(s0, "KIT2") % 8);
        k.accent = _c(K.ACCENT_COLOR, TE.lane(s0, "KIT3") % 8);
        k.pattern = uint8(TE.lane(s0, "KITP") % 7);
    }

    function _r(int256 x, int256 y, uint256 w, uint256 h, bytes3 fill) private pure returns (string memory) {
        return string.concat(
            '<rect x="', SvgNum.i(x), '" y="', SvgNum.i(y),
            '" width="', SvgNum.u(w), '" height="', SvgNum.u(h),
            '" fill="#', SvgNum.color(fill), '"/>'
        );
    }

    /// @dev Mirrors kitRects() in the reference renderer, rect for rect.
    function kitLayer(Kit memory kit, bytes3 accent) public pure returns (string memory out) {
        int256 y = 24;
        out = string.concat(_r(0, y - 1, 32, 1, K.INK), _r(2, y, 28, 8, kit.primary));
        if (kit.pattern == 1) {
            out = string.concat(out, _r(2, y, 5, 8, kit.secondary), _r(25, y, 5, 8, kit.secondary));
        } else if (kit.pattern == 2) {
            for (uint256 i; i < 5; ++i) out = string.concat(out, _r(int256(4 + i * 6), y, 3, 8, kit.secondary));
        } else if (kit.pattern == 3) {
            out = string.concat(out, _r(2, y + 2, 28, 2, kit.secondary), _r(2, y + 6, 28, 2, kit.secondary));
        } else if (kit.pattern == 4) {
            out = string.concat(out, _r(16, y, 14, 8, kit.secondary));
        } else if (kit.pattern == 5) {
            for (uint256 i; i < 8; ++i) {
                out = string.concat(out, _r(int256(6 + i * 2), y + int256(i), 4, 1, kit.secondary));
            }
        } else if (kit.pattern == 6) {
            for (uint256 i; i < 4; ++i) {
                out = string.concat(
                    out,
                    _r(14 - int256(i * 2), y + 2 + int256(i), 3, 1, kit.secondary),
                    _r(16 + int256(i * 2), y + 2 + int256(i), 3, 1, kit.secondary)
                );
            }
        }
        // collar + cuffs carry the PLAYER's accent, so a squad in one kit
        // still has eleven distinguishable people in it
        out = string.concat(
            out, _r(12, y, 8, 2, accent), _r(2, y + 6, 3, 2, accent), _r(27, y + 6, 3, 2, accent),
            _r(13, y, 6, 1, K.INK)
        );
    }

    // ------------------------------------------------------------- render

    /// @notice The parity entry point: render from identity alone, with no
    /// collection lookup, so the reference and the chain can be compared.
    function imageOf(bytes32 dna, uint256 appearance) public view returns (string memory) {
        bytes32 s0 = TE.seedOf(dna, appearance);
        TE.Traits memory t = TE.traitsOf(s0);
        Kit memory kit = freeAgentKit(s0);
        bytes3[12] memory pal = paletteFor(t, kit);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges" width="100%" height="100%">',
            _r(0, 0, 32, 32, _c(K.BG_COLOR, t.bg)),
            kitLayer(kit, pal[8]),
            _r(13, 21, 6, 3, pal[2]),
            faces.identity(t, pal),
            "</svg>"
        );
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        string memory image = imageOf(v.dna, v.appearance);
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
                        _attributes(v),
                        "}"
                    )
                )
            )
        );
    }

    function _attributes(FobalTypes.PlayerView memory v) private pure returns (string memory) {
        TE.Traits memory t = TE.traitsOf(TE.seedOf(v.dna, v.appearance));
        return string.concat(
            '[{"trait_type":"Position","value":"',
            _position(v.core.position),
            '"},{"trait_type":"Level","value":',
            SvgNum.u(v.core.level),
            '},{"trait_type":"XP","value":',
            SvgNum.u(v.core.xp),
            '},{"trait_type":"Generation","value":',
            SvgNum.u(v.core.generation),
            '},{"trait_type":"Matches","value":',
            SvgNum.u(v.stats.matchesPlayed),
            '},{"trait_type":"Goals","value":',
            SvgNum.u(v.stats.goals),
            '},{"trait_type":"Head","value":',
            SvgNum.u(t.head),
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
