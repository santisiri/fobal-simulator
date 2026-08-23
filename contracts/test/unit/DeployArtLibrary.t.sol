// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {DeployArtLibrary} from "../../script/DeployArtLibrary.s.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";

/// The rollout runbook's step 2, executed. It used to revert on its first
/// setClass — the library grants roles to its constructor argument only, and
/// the script named the TIMELOCK there while broadcasting as the deployer —
/// and it installed a hand-written list of eight classes out of thirteen.
/// Neither failure was visible until someone ran it against a real chain.
contract DeployArtLibraryTest is Test {
    address internal timelock = makeAddr("timelock");

    /// @dev admin passed directly, never through vm.setEnv — that mutates a
    /// process global and forge runs tests in parallel, so two tests
    /// configuring the same script race each other.
    function _run() internal returns (FobalArtLibrary lib) {
        lib = new DeployArtLibrary().runWith(timelock);
    }

    function test_scriptInstallsEveryGeneratedClass() public {
        FobalArtLibrary lib = _run();
        bytes32[] memory names = K.classNames();
        assertEq(names.length, K.ART_CLASS_COUNT, "the generated list must be complete");

        uint256 rects;
        for (uint256 i; i < names.length; ++i) {
            uint8 n = lib.partCount(names[i]);
            assertGt(n, 0, "every class must be installed, not skipped");
            for (uint8 p; p < n; ++p) {
                rects += lib.part(names[i], p).length;
            }
        }
        assertGt(rects, 250, "the atlas must decode to real art");
    }

    function test_adminIsHandedOverAndTheDeployerStepsAway() public {
        FobalArtLibrary lib = _run();
        assertTrue(lib.hasRole(lib.ART_ADMIN_ROLE(), timelock), "timelock must hold art admin");
        assertTrue(lib.hasRole(lib.DEFAULT_ADMIN_ROLE(), timelock), "timelock must hold default admin");
        assertFalse(lib.hasRole(lib.ART_ADMIN_ROLE(), address(this)), "deployer must renounce art admin");
        assertFalse(lib.hasRole(lib.DEFAULT_ADMIN_ROLE(), address(this)), "deployer must renounce default admin");
    }

    /// Handover is not enough on its own: the timelock must actually be able
    /// to use the rights it was given, or the atlas is frozen unsealed.
    function test_theTimelockCanStillRepointAnUnsealedClass() public {
        FobalArtLibrary lib = _run();
        bytes32 heads = K.classNames()[0];
        bytes memory blob = lib.part(heads, 0).length > 0
            ? vm.parseBytes(vm.replace(vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/HEADS.hex")), "\n", ""))
            : bytes("");
        vm.prank(timelock);
        lib.setClass(heads, blob);
        assertGt(lib.partCount(heads), 0);
    }

    /// Until the timelock exists (rollout step 7) FOBAL_ART_ADMIN is the
    /// operator's OWN key — the same account that broadcasts. Granting then
    /// renouncing the same account would leave the library with no
    /// administrator at all: unable to set a class, and unable to ever be
    /// sealed. There is simply nothing to hand over.
    function test_adminIsTheDeployer_keepsTheRoles() public {
        FobalArtLibrary lib = new DeployArtLibrary().runWith(address(this));
        assertTrue(lib.hasRole(lib.ART_ADMIN_ROLE(), address(this)), "operator must keep art admin");
        assertTrue(lib.hasRole(lib.DEFAULT_ADMIN_ROLE(), address(this)), "operator must keep default admin");
        // and the atlas is still fully installed
        bytes32[] memory names = K.classNames();
        for (uint256 i; i < names.length; ++i) assertGt(lib.partCount(names[i]), 0);
    }

    /// Nothing is sealed by the script: sealing must follow inspection of
    /// real rendered output, because there is no unseal.
    function test_scriptDoesNotSeal() public {
        FobalArtLibrary lib = _run();
        bytes32[] memory names = K.classNames();
        for (uint256 i; i < names.length; ++i) {
            assertFalse(lib.classInfo(names[i]).sealed_, "the script must never seal");
        }
    }
}
