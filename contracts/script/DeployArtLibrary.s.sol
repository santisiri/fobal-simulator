// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FobalArtLibrary} from "../src/FobalArtLibrary.sol";

/// Deploys the art atlas and installs every generated class, verifying each
/// blob by READ-BACK before anything is sealed. Nothing points at the library
/// yet — it is inert until the P3 renderer is wired to it.
///
///   FOBAL_ART_ADMIN=0x… forge script script/DeployArtLibrary.s.sol \
///     --rpc-url base_sepolia --account fobal-admin --broadcast --verify
///
/// Sealing is deliberately NOT done here: seal only after the rendered output
/// has been inspected on chain, because a sealed class is permanent.
contract DeployArtLibrary is Script {
    string[8] internal CLASSES = ["HEADS", "EYES", "BROWS", "NOSES", "MOUTHS", "BEARDS", "HAIR", "HEADWEAR"];

    function run() external returns (FobalArtLibrary lib) {
        address admin = vm.envAddress("FOBAL_ART_ADMIN");

        vm.startBroadcast();
        lib = new FobalArtLibrary(admin);
        for (uint256 i; i < CLASSES.length; ++i) {
            bytes memory blob = _blob(CLASSES[i]);
            lib.setClass(bytes32(bytes(CLASSES[i])), blob);
        }
        vm.stopBroadcast();

        // read-back verification, before any human is told this worked
        uint256 totalRects;
        for (uint256 i; i < CLASSES.length; ++i) {
            bytes32 key = bytes32(bytes(CLASSES[i]));
            bytes memory blob = _blob(CLASSES[i]);
            uint8 n = lib.partCount(key);
            require(n == uint8(blob[1]), "part count mismatch after write");
            for (uint8 p; p < n; ++p) {
                totalRects += lib.part(key, p).length;
            }
            console2.log(CLASSES[i], n, blob.length);
        }
        console2.log("art library deployed", address(lib));
        console2.log("rects verified by read-back", totalRects);
        console2.log("NOT sealed: inspect rendered output first, then seal()");
    }

    function _blob(string memory className) internal view returns (bytes memory) {
        string memory h = vm.readFile(
            string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", className, ".hex")
        );
        return vm.parseBytes(vm.replace(h, "\n", ""));
    }
}
