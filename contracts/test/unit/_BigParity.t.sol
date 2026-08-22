// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";
import {FobalSquadRegistry} from "../../src/art/FobalSquadRegistry.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalTraitEngine as TE} from "../../src/art/FobalTraitEngine.sol";

contract BigParityTest is Test {
    FobalArtLibrary internal art;
    FobalRendererV2_1 internal renderer;
    address internal admin = makeAddr("admin");
    string[13] internal CLASSES =
        ["HEADS", "SHADING", "EARS", "EYES", "BROWS", "NOSES", "MOUTHS", "BEARDS", "HAIR", "HEADWEAR", "NECKS", "BUILDS", "COLLARS"];

    bytes32[] internal fxDna;
    uint256[] internal fxAppearance;
    bytes32[] internal fxSvgHash;

    function _blob(string memory className) internal view returns (bytes memory) {
        string memory h = vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", className, ".hex"));
        return vm.parseBytes(vm.replace(h, "\n", ""));
    }

    function setUp() public {
        art = new FobalArtLibrary(admin);
        vm.startPrank(admin);
        for (uint256 i; i < CLASSES.length; ++i) art.setClass(bytes32(bytes(CLASSES[i])), _blob(CLASSES[i]));
        vm.stopPrank();
        renderer = new FobalRendererV2_1(
            IPlayerReader2(address(0)), new FobalFaceComposer(art), new FobalKitComposer(),
            FobalSquadRegistry(address(0)), FobalKitRegistry(address(0))
        );
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/fixtures/_bigfx.json"));
        fxDna = vm.parseJsonBytes32Array(json, ".dna");
        fxAppearance = vm.parseJsonUintArray(json, ".appearance");
        fxSvgHash = vm.parseJsonBytes32Array(json, ".svgHash");
    }

    function test_bigParity() public view {
        uint256 bad;
        for (uint256 i; i < fxDna.length; ++i) {
            bytes32 s0 = TE.seedOf(fxDna[i], fxAppearance[i]);
            string memory svg = renderer.imageWithKit(fxDna[i], fxAppearance[i], renderer.freeAgentKit(s0));
            if (keccak256(bytes(svg)) != fxSvgHash[i]) {
                if (bad < 5) {
                    TE.Traits memory t = TE.traitsOf(s0);
                    console.log("MISMATCH idx", i);
                    console.log("head", t.head, "mouth", t.mouth);
                    console.log("hair", t.hair, "headwear", t.headwear);
                    console.log("beard", t.beard, "ears", t.ears);
                    console.log("eyes", t.eyes, "brows", t.brows);
                    console.log("nose", t.nose, "build", t.build);
                    console.log("collar", t.collar, "skin", t.skin);
                    console.log(svg);
                }
                ++bad;
            }
        }
        console.log("bad", bad, "of", fxDna.length);
        assertEq(bad, 0);
    }
}
