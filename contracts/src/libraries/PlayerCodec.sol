// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Bit packing for player skills and appearance.
///
/// Skills (schema 1): 12 skills x 8 bits in the LOW 96 bits of a uint256.
/// Lane order: 0 pace, 1 finishing, 2 passing, 3 dribbling, 4 defending,
/// 5 physical, 6 stamina, 7 vision, 8 technique, 9 aggression, 10 composure,
/// 11 goalkeeping. Values 0-100. High 160 bits MUST be zero.
///
/// Appearance: nibble-packed visual traits in the LOW 32 bits. Trait slots:
/// 0 background, 1 skin, 2 hairColor, 3 hairStyle, 4 eyes, 5 shirt palette,
/// 6 accessory, 7 reserved. High bits reserved (must be zero at mint).
library PlayerCodec {
    uint256 internal constant SKILL_COUNT = 12;
    uint256 internal constant SKILL_MAX = 100;
    uint256 internal constant SKILLS_MASK = (1 << (SKILL_COUNT * 8)) - 1;
    uint256 internal constant APPEARANCE_MASK = (1 << 32) - 1;

    error SkillIndexOutOfRange(uint256 index);

    function skill(uint256 packed, uint256 index) internal pure returns (uint8) {
        if (index >= SKILL_COUNT) revert SkillIndexOutOfRange(index);
        return uint8(packed >> (index * 8));
    }

    function setSkill(uint256 packed, uint256 index, uint8 value) internal pure returns (uint256) {
        if (index >= SKILL_COUNT) revert SkillIndexOutOfRange(index);
        uint256 shift = index * 8;
        return (packed & ~(uint256(0xff) << shift)) | (uint256(value) << shift);
    }

    /// @notice Sum of all 12 skill lanes (the "power" of a player).
    function totalPoints(uint256 packed) internal pure returns (uint256 total) {
        for (uint256 i; i < SKILL_COUNT; ++i) {
            total += uint8(packed >> (i * 8));
        }
    }

    /// @notice True iff every lane is <= 100 and no stray high bits are set.
    function validSkills(uint256 packed) internal pure returns (bool) {
        if (packed & ~SKILLS_MASK != 0) return false;
        for (uint256 i; i < SKILL_COUNT; ++i) {
            if (uint8(packed >> (i * 8)) > SKILL_MAX) return false;
        }
        return true;
    }

    /// @notice True iff appearance uses only the defined low bits.
    function validAppearance(uint256 packed) internal pure returns (bool) {
        return packed & ~APPEARANCE_MASK == 0;
    }

    /// @notice Read a 4-bit appearance trait by slot index (0..7).
    function trait(uint256 appearance, uint256 slot) internal pure returns (uint8) {
        return uint8((appearance >> (slot * 4)) & 0x0f);
    }
}
