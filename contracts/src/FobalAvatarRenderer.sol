// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IFobalRenderer} from "./interfaces/IFobalRenderer.sol";
import {FobalTypes} from "./interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "./libraries/PlayerCodec.sol";

interface IPlayerReader {
    function playerView(uint256 tokenId) external view returns (FobalTypes.PlayerView memory);
}

/// @title FobalAvatarRenderer v1 — a footballer that cannot be taken away.
/// @notice Pure-view, deterministic: identical canonical state produces
/// identical metadata and SVG bytes, forever, with no server. Renderers are
/// versioned and swappable by governance; the immutable appearance/dna they
/// draw from never changes, so a renderer swap can restyle but never
/// re-identify a player. Richer art (3D, animation) belongs off-chain — this
/// is the canonical representation of record.
contract FobalAvatarRenderer is IFobalRenderer {
    using Strings for uint256;
    using PlayerCodec for uint256;

    IPlayerReader public immutable player;

    string public constant VERSION = "avatar-v1";

    // 16-entry palettes; traits are 4-bit indices. Backgrounds, skin tones,
    // hair and kit colors are chosen to read well at 24x24.
    bytes constant BG = hex"1b243220303f28323c2d24381f363033272b1e2a443a3226"; // 8x3 bytes
    bytes constant SKIN = hex"f2c9a4e0ac69c686428d55245c3317f8d9c0a86b3c713f17";
    bytes constant HAIR = hex"1a15125b3a1dc8a24a9c2b1f2e2e34e8e4da763fb81f6b3a";
    bytes constant KIT = hex"d8342c57b8e82be08fe0c04a8a5cf6e8712f2f2f38f2ece0";

    constructor(IPlayerReader playerContract) {
        player = playerContract;
    }

    function version() external pure returns (string memory) {
        return VERSION;
    }

    // ---------------------------------------------------------------- token

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        FobalTypes.PlayerView memory v = player.playerView(tokenId);
        string memory image = Base64.encode(bytes(_svg(v)));
        string memory json = string.concat(
            '{"name":"',
            _escape(v.name),
            " #",
            tokenId.toString(),
            '","description":"Fobal footballer. Fully on-chain identity: DNA, appearance, skills and career live on the blockchain and travel with the NFT.",',
            '"image":"data:image/svg+xml;base64,',
            image,
            '",',
            '"attributes":',
            _attributes(v),
            ',"fobal":{"schemaVersion":1,"renderer":"',
            VERSION,
            '","dna":"',
            uint256(v.dna).toHexString(32),
            '","generation":',
            uint256(v.core.generation).toString(),
            ',"skillsPacked":"',
            v.skills.toHexString(),
            '","appearancePacked":"',
            v.appearance.toHexString(),
            '"}}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ----------------------------------------------------------- attributes

    function _attributes(FobalTypes.PlayerView memory v) internal pure returns (string memory) {
        string memory head = string.concat(
            '[{"trait_type":"Position","value":"',
            _position(v.core.position),
            '"},{"trait_type":"Level","value":',
            uint256(v.core.level).toString(),
            '},{"trait_type":"XP","value":',
            uint256(v.core.xp).toString(),
            '},{"trait_type":"Country","value":',
            uint256(v.core.country).toString(),
            '},{"trait_type":"Generation","value":',
            uint256(v.core.generation).toString(),
            "},"
        );
        string memory skills = string.concat(
            _skillAttr("Pace", v.skills, 0),
            _skillAttr("Finishing", v.skills, 1),
            _skillAttr("Passing", v.skills, 2),
            _skillAttr("Dribbling", v.skills, 3),
            _skillAttr("Defending", v.skills, 4),
            _skillAttr("Physical", v.skills, 5),
            _skillAttr("Stamina", v.skills, 6),
            _skillAttr("Vision", v.skills, 7),
            _skillAttr("Technique", v.skills, 8),
            _skillAttr("Aggression", v.skills, 9),
            _skillAttr("Composure", v.skills, 10),
            _skillAttr("Goalkeeping", v.skills, 11)
        );
        string memory career = string.concat(
            '{"trait_type":"Matches","value":',
            uint256(v.stats.matchesPlayed).toString(),
            '},{"trait_type":"Wins","value":',
            uint256(v.stats.wins).toString(),
            '},{"trait_type":"Draws","value":',
            uint256(v.stats.draws).toString(),
            '},{"trait_type":"Losses","value":',
            uint256(v.stats.losses).toString(),
            '},{"trait_type":"Goals","value":',
            uint256(v.stats.goals).toString(),
            '},{"trait_type":"Assists","value":',
            uint256(v.stats.assists).toString(),
            '},{"trait_type":"Clean Sheets","value":',
            uint256(v.stats.cleanSheets).toString(),
            "}]"
        );
        return string.concat(head, skills, career);
    }

    function _skillAttr(string memory label, uint256 skills, uint256 lane)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '{"trait_type":"', label, '","value":', uint256(skills.skill(lane)).toString(), "},"
        );
    }

    function _position(uint8 p) internal pure returns (string memory) {
        if (p == 0) return "GK";
        if (p == 1) return "DF";
        if (p == 2) return "MF";
        return "FW";
    }

    // ------------------------------------------------------------------ svg

    /// @dev 24x24 pixel footballer. Every visual decision derives from the
    /// immutable appearance nibbles (+ dna bits for freckle placement), so
    /// the avatar is reproducible from canonical state alone.
    function _svg(FobalTypes.PlayerView memory v) internal pure returns (string memory) {
        uint256 a = v.appearance;
        string memory bg = _pal(BG, a.trait(0) % 8);
        string memory skin = _pal(SKIN, a.trait(1) % 8);
        string memory hair = _pal(HAIR, a.trait(2) % 8);
        string memory kitA = _pal(KIT, a.trait(5) % 8);
        string memory kitB = _pal(KIT, (a.trait(5) + 3) % 8);

        string memory head = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
            '<rect width="24" height="24" fill="#',
            bg,
            '"/>',
            _hairBack(a.trait(3) % 5, hair),
            '<rect x="8" y="4" width="8" height="8" fill="#',
            skin,
            '"/>',
            _hairFront(a.trait(3) % 5, hair),
            _eyes(a.trait(4), v.dna),
            '<rect x="11" y="10" width="2" height="1" fill="#00000033"/>'
        );
        string memory body = string.concat(
            '<rect x="7" y="12" width="10" height="7" fill="#',
            kitA,
            '"/>',
            '<rect x="7" y="12" width="10" height="2" fill="#',
            kitB,
            '"/>',
            '<rect x="5" y="13" width="2" height="5" fill="#',
            kitA,
            '"/>',
            '<rect x="17" y="13" width="2" height="5" fill="#',
            kitA,
            '"/>',
            '<rect x="5" y="18" width="2" height="1" fill="#',
            skin,
            '"/>',
            '<rect x="17" y="18" width="2" height="1" fill="#',
            skin,
            '"/>'
        );
        string memory legs = string.concat(
            '<rect x="8" y="19" width="8" height="2" fill="#',
            kitB,
            '"/>',
            '<rect x="9" y="21" width="2" height="2" fill="#',
            skin,
            '"/>',
            '<rect x="13" y="21" width="2" height="2" fill="#',
            skin,
            '"/>',
            _accessory(a.trait(6) % 4, hair, kitB),
            _badge(v.core.position, kitA),
            "</svg>"
        );
        return string.concat(head, body, legs);
    }

    function _hairBack(uint256 style, string memory hair) internal pure returns (string memory) {
        if (style == 3) {
            // long hair falls behind the shoulders
            return string.concat('<rect x="7" y="4" width="10" height="10" fill="#', hair, '"/>');
        }
        return "";
    }

    function _hairFront(uint256 style, string memory hair) internal pure returns (string memory) {
        if (style == 0) return ""; // shaved
        if (style == 1) {
            return string.concat('<rect x="8" y="3" width="8" height="2" fill="#', hair, '"/>');
        }
        if (style == 2) {
            return string.concat(
                '<rect x="8" y="3" width="8" height="2" fill="#',
                hair,
                '"/>',
                '<rect x="10" y="2" width="4" height="1" fill="#',
                hair,
                '"/>'
            );
        }
        if (style == 3) {
            return string.concat('<rect x="8" y="3" width="8" height="2" fill="#', hair, '"/>');
        }
        // mohawk
        return string.concat('<rect x="11" y="1" width="2" height="4" fill="#', hair, '"/>');
    }

    function _eyes(uint8 eyeTrait, bytes32 dna) internal pure returns (string memory) {
        // eye row shifts one pixel by a dna bit — same dna, same face, always
        string memory y = uint256(dna) & 1 == 0 ? "7" : "6";
        string memory color = eyeTrait % 3 == 0 ? "1a1512" : (eyeTrait % 3 == 1 ? "2456a8" : "2e6b2e");
        return string.concat(
            '<rect x="9" y="',
            y,
            '" width="2" height="2" fill="#',
            color,
            '"/>',
            '<rect x="13" y="',
            y,
            '" width="2" height="2" fill="#',
            color,
            '"/>'
        );
    }

    function _accessory(uint256 kind, string memory hair, string memory accent)
        internal
        pure
        returns (string memory)
    {
        if (kind == 1) {
            return string.concat('<rect x="8" y="4" width="8" height="1" fill="#', accent, '"/>'); // headband
        }
        if (kind == 2) {
            return string.concat('<rect x="9" y="10" width="6" height="2" fill="#', hair, '"/>'); // beard
        }
        if (kind == 3) {
            return '<rect x="8" y="6" width="8" height="1" fill="#00000055"/>'; // visor shadow
        }
        return "";
    }

    function _badge(uint8 position, string memory kitA) internal pure returns (string memory) {
        // small position pip, bottom-left, kit-colored
        string memory h = position == 0 ? "1" : position == 1 ? "2" : position == 2 ? "3" : "4";
        return string.concat(
            '<rect x="1" y="', (23 - _u(h)).toString(), '" width="2" height="', h, '" fill="#', kitA, '"/>'
        );
    }

    function _u(string memory s) internal pure returns (uint256) {
        return uint256(uint8(bytes(s)[0])) - 48;
    }

    function _pal(bytes memory palette, uint256 index) internal pure returns (string memory) {
        // palettes are contiguous 3-byte RGB triplets (the underscores in the
        // hex literals are separators only and do not occupy bytes)
        uint256 offset = index * 3;
        bytes memory out = new bytes(6);
        for (uint256 i; i < 3; ++i) {
            bytes1 b = palette[offset + i];
            out[i * 2] = _hexChar(uint8(b) >> 4);
            out[i * 2 + 1] = _hexChar(uint8(b) & 0x0f);
        }
        return string(out);
    }

    function _hexChar(uint8 nibble) internal pure returns (bytes1) {
        return nibble < 10 ? bytes1(nibble + 0x30) : bytes1(nibble + 0x57);
    }

    function _escape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 2);
        uint256 n;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") out[n++] = "\\";
            // control characters are rejected at mint (names are validated),
            // so quote/backslash escaping is sufficient here
            out[n++] = c;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
        return string(out);
    }
}
