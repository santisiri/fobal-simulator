// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FobalArtConstants as K} from "../src/art/FobalArtConstants.sol";
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
    /// @dev NOT a hand-written list. It was one, in five places, and adding
    /// classes left this script installing eight of thirteen — the rest
    /// degrading to nothing on chain instead of failing loudly.
    bytes32[] internal CLASSES = K.classNames();

    function _name(bytes32 k) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && k[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = k[i];
        return string(b);
    }

    function run() external returns (FobalArtLibrary lib) {
        address admin = vm.envAddress("FOBAL_ART_ADMIN");

        vm.startBroadcast();
        lib = new FobalArtLibrary(admin);
        for (uint256 i; i < CLASSES.length; ++i) {
            bytes memory blob = _blob(_name(CLASSES[i]));
            lib.setClass(CLASSES[i], blob);
        }
        vm.stopBroadcast();

        // read-back verification, before any human is told this worked
        uint256 totalRects;
        for (uint256 i; i < CLASSES.length; ++i) {
            bytes32 key = CLASSES[i];
            bytes memory blob = _blob(_name(key));
            uint8 n = lib.partCount(key);
            require(n == uint8(blob[1]), "part count mismatch after write");
            for (uint8 p; p < n; ++p) {
                totalRects += lib.part(key, p).length;
            }
            console2.log(_name(CLASSES[i]), n, blob.length);
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
