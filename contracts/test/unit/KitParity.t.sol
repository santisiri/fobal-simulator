// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalSquadRegistry} from "../../src/art/FobalSquadRegistry.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";

/// P4 parity: with an EXPLICIT club kit, the Solidity output still matches
/// the JS reference byte for byte. P3 proved the free-agent path; this proves
/// the path players will actually be rendered through, across every pattern.
contract KitParityTest is Test {
    FobalRendererV2_1 internal r2;
    /// @dev the GENERATED install list — see FobalArtConstants.classNames()
    bytes32[] internal CLASSES = K.classNames();

    function _name(bytes32 k) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && k[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = k[i];
        return string(b);
    }

    bytes32[] internal dna;
    uint256[] internal appearance;
    uint256[] internal kitP;
    uint256[] internal kitS;
    uint256[] internal kitA;
    uint256[] internal kitPat;
    bytes32[] internal want;

    function setUp() public {
        FobalArtLibrary art = new FobalArtLibrary(address(this));
        for (uint256 i; i < CLASSES.length; ++i) {
            string memory h = vm.readFile(
                string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", _name(CLASSES[i]), ".hex")
            );
            art.setClass(CLASSES[i], vm.parseBytes(vm.replace(h, "\n", "")));
        }
        r2 = new FobalRendererV2_1(
            IPlayerReader2(address(0)),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            FobalSquadRegistry(address(0)),
            FobalKitRegistry(address(0))
        );
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../packages/art/gen/fixtures/render.json")
        );
        dna = vm.parseJsonBytes32Array(json, ".dna");
        appearance = vm.parseJsonUintArray(json, ".appearance");
        kitP = vm.parseJsonUintArray(json, ".kitPrimary");
        kitS = vm.parseJsonUintArray(json, ".kitSecondary");
        kitA = vm.parseJsonUintArray(json, ".kitAccent");
        kitPat = vm.parseJsonUintArray(json, ".kitPattern");
        want = vm.parseJsonBytes32Array(json, ".svgKitHash");
    }

    function test_clubKitRenderIsByteIdenticalToTheReference() public view {
        assertEq(dna.length, 64);
        for (uint256 i; i < dna.length; ++i) {
            FobalKitComposer.Kit memory kit =
                FobalKitComposer.Kit(uint24(kitP[i]), uint24(kitS[i]), uint24(kitA[i]), uint8(kitPat[i]));
            assertEq(
                keccak256(bytes(r2.imageWithKit(dna[i], appearance[i], kit))),
                want[i],
                string.concat("club-kit SVG differs from the reference at fixture ", vm.toString(i))
            );
        }
    }

    /// Every kit pattern must be exercised, or "all patterns match" would be
    /// a claim about whichever few the fixture set happened to hit.
    function test_everyPatternIsCovered() public view {
        bool[7] memory seen;
        for (uint256 i; i < kitPat.length; ++i) seen[kitPat[i]] = true;
        for (uint256 p; p < 7; ++p) assertTrue(seen[p], string.concat("pattern ", vm.toString(p), " untested"));
    }

    function testFuzz_anyKitRendersWithoutReverting(uint24 p, uint24 s, uint24 a, uint8 pattern) public view {
        FobalKitComposer.Kit memory kit = FobalKitComposer.Kit(p, s, a, uint8(bound(pattern, 0, 6)));
        assertGt(bytes(r2.imageWithKit(dna[0], appearance[0], kit)).length, 200);
    }

    /// The face is invariant under every possible kit — the P4 promise,
    /// checked against the rendered bytes rather than only the hash.
    function testFuzz_kitNeverAltersTheFace(uint24 p, uint24 s, uint8 pattern) public view {
        bytes32 f = r2.faceHash(dna[0], appearance[0]);
        FobalKitComposer.Kit memory kit = FobalKitComposer.Kit(p, s, p, uint8(bound(pattern, 0, 6)));
        r2.imageWithKit(dna[0], appearance[0], kit);
        assertEq(r2.faceHash(dna[0], appearance[0]), f);
    }
}
