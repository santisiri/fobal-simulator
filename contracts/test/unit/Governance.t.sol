// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {IFobalRenderer} from "../../src/interfaces/IFobalRenderer.sol";

contract StubRenderer is IFobalRenderer {
    string private mark;
    constructor(string memory m) { mark = m; }
    function tokenURI(uint256) external view returns (string memory) { return mark; }
    function version() external pure returns (string memory) { return "stub"; }
}

/// P6: art changes should be ANNOUNCED, not instant. The router already
/// takes an admin address, so this proves the intended production wiring
/// works end to end rather than merely recommending it in a doc.
///
/// Note what is deliberately NOT timelocked: FobalPlayer's own
/// DEFAULT_ADMIN_ROLE, which stays on the operator key. Moving it is
/// irreversible, and keeping it separate means the timelock can never lock
/// anyone out of the one-transaction rollback to the previous renderer.
contract GovernanceTest is Test {
    TimelockController internal timelock;
    FobalRendererRouter internal router;
    StubRenderer internal v1;
    StubRenderer internal v2;

    address internal proposer = makeAddr("proposer");
    address internal executor = makeAddr("executor");
    address internal outsider = makeAddr("outsider");
    uint256 internal constant DELAY = 48 hours;

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        timelock = new TimelockController(DELAY, proposers, executors, address(0));

        v1 = new StubRenderer("v1");
        v2 = new StubRenderer("v2");
        // the timelock, not an EOA, owns routing
        router = new FobalRendererRouter(address(timelock), address(v1));
    }

    function _schedule(bytes memory data) internal returns (bytes32 id) {
        vm.prank(proposer);
        timelock.schedule(address(router), 0, data, bytes32(0), bytes32(0), DELAY);
        id = timelock.hashOperation(address(router), 0, data, bytes32(0), bytes32(0));
    }

    function test_routingChangeMustWaitTheFullDelay() public {
        bytes memory data = abi.encodeCall(FobalRendererRouter.setDefaultRenderer, (address(v2)));
        _schedule(data);

        // too early
        vm.prank(executor);
        vm.expectRevert();
        timelock.execute(address(router), 0, data, bytes32(0), bytes32(0));
        assertEq(router.defaultRenderer(), address(v1), "art must not move before the delay");

        skip(DELAY + 1);
        vm.prank(executor);
        timelock.execute(address(router), 0, data, bytes32(0), bytes32(0));
        assertEq(router.defaultRenderer(), address(v2), "and must move after it");
    }

    function test_anEoaCannotRerouteAtAll() public {
        vm.prank(outsider);
        vm.expectRevert();
        router.setDefaultRenderer(address(v2));
        // not even the deployer
        vm.expectRevert();
        router.setDefaultRenderer(address(v2));
    }

    /// A queued change is visible to anyone before it lands — which is the
    /// entire point of announcing art changes.
    function test_pendingChangeIsPubliclyVisibleBeforeItLands() public {
        bytes32 id = _schedule(abi.encodeCall(FobalRendererRouter.setDefaultRenderer, (address(v2))));
        assertTrue(timelock.isOperationPending(id), "queued and inspectable");
        assertFalse(timelock.isOperationReady(id), "but not yet executable");
        skip(DELAY + 1);
        assertTrue(timelock.isOperationReady(id));
    }

    /// The escape hatch: a bad change can be cancelled while it waits.
    function test_aQueuedChangeCanBeCancelled() public {
        bytes memory data = abi.encodeCall(FobalRendererRouter.setDefaultRenderer, (address(v2)));
        bytes32 id = _schedule(data);
        vm.prank(proposer);      // CANCELLER_ROLE is granted to proposers by default
        timelock.cancel(id);
        skip(DELAY + 1);
        vm.prank(executor);
        vm.expectRevert();
        timelock.execute(address(router), 0, data, bytes32(0), bytes32(0));
        assertEq(router.defaultRenderer(), address(v1));
    }

    /// Canary pins go through the same gate — no fast lane for "just one token".
    function test_pinsAreTimelockedToo() public {
        bytes memory data = abi.encodeCall(FobalRendererRouter.pin, (1, address(v2)));
        _schedule(data);
        skip(DELAY + 1);
        vm.prank(executor);
        timelock.execute(address(router), 0, data, bytes32(0), bytes32(0));
        assertEq(router.rendererFor(1), address(v2));
        assertEq(router.rendererFor(2), address(v1), "and only that token moved");
    }

    /// The art atlas is the other privileged surface; sealing is what makes
    /// a class permanent, and it should be as deliberate as a reroute.
    function test_artLibraryCanBeGovernedByTheSameTimelock() public {
        FobalArtLibrary art = new FobalArtLibrary(address(timelock));
        assertTrue(art.hasRole(art.ART_ADMIN_ROLE(), address(timelock)));
        vm.prank(outsider);
        vm.expectRevert();
        art.setClass(bytes32("HAIR"), hex"0100");
    }
}
