// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";

/// The atlas as ACTUALLY DEPLOYED, decoded from chain and compared rect by
/// rect against the generated fixture. The deploy script verifies its own
/// write, but it does so inside the same run — this reads the finished
/// contract back from an independent process, which is the only version of
/// the claim that means anything.
///
///   forge test --match-contract DeployedAtlas --fork-url https://sepolia.base.org -vv
contract DeployedAtlasTest is Test {
    address constant LIBRARY = 0x711B1178CE1892DD3C443f462dC7a7B4c062c7aF;
    address constant ART_ADMIN = 0x26250e47500943464290A77ae3508a3001d9B69d;

    function test_deployedAtlasMatchesTheGeneratedFixture() public {
        if (block.chainid != 84532) {
            emit log("skipped: not forked onto Base Sepolia (84532)");
            return;
        }
        FobalArtLibrary lib = FobalArtLibrary(LIBRARY);

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/fixtures/rects.json"));
        string[] memory fxClass = vm.parseJsonStringArray(json, ".className");
        uint256[] memory fxPart = vm.parseJsonUintArray(json, ".partIndex");
        int256[] memory fxX = vm.parseJsonIntArray(json, ".x");
        int256[] memory fxY = vm.parseJsonIntArray(json, ".y");
        uint256[] memory fxW = vm.parseJsonUintArray(json, ".w");
        uint256[] memory fxH = vm.parseJsonUintArray(json, ".h");
        uint256[] memory fxSlot = vm.parseJsonUintArray(json, ".slot");

        bytes32[] memory names = K.classNames();
        uint256 k;
        for (uint256 i; i < names.length; ++i) {
            uint8 n = lib.partCount(names[i]);
            for (uint8 p; p < n; ++p) {
                FobalArtLibrary.Rect[] memory rects = lib.part(names[i], p);
                for (uint256 r; r < rects.length; ++r) {
                    assertLt(k, fxX.length, "chain holds MORE rects than the fixture");
                    assertEq(fxPart[k], uint256(p), "part order");
                    assertEq(int256(rects[r].x), fxX[k], fxClass[k]);
                    assertEq(int256(rects[r].y), fxY[k], fxClass[k]);
                    assertEq(uint256(rects[r].w), fxW[k], fxClass[k]);
                    assertEq(uint256(rects[r].h), fxH[k], fxClass[k]);
                    assertEq(uint256(rects[r].slot), fxSlot[k], fxClass[k]);
                    ++k;
                }
            }
        }
        assertEq(k, fxX.length, "chain holds FEWER rects than the fixture");
        emit log_named_uint("rects decoded from chain and matched", k);

        // and the operator can still fix or seal it
        assertTrue(lib.hasRole(lib.ART_ADMIN_ROLE(), ART_ADMIN), "art admin lost");
        for (uint256 i; i < names.length; ++i) {
            assertFalse(lib.classInfo(names[i]).sealed_, "nothing may be sealed yet");
        }
        emit log("art admin retained, nothing sealed");
    }
}
