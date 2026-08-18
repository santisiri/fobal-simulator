// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseFixture} from "../BaseFixture.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";
import {IFobalRenderer} from "../../src/interfaces/IFobalRenderer.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// reverts on every token
contract RevertingRenderer is IFobalRenderer {
    function tokenURI(uint256) external pure returns (string memory) {
        revert("boom");
    }
    function version() external pure returns (string memory) {
        return "reverting";
    }
}

/// burns every drop of gas it is handed — the case try/catch alone CANNOT
/// catch, and the reason the router reserves gas instead of hoping
contract GasBombRenderer is IFobalRenderer {
    mapping(uint256 => uint256) private sink;
    function tokenURI(uint256) external view returns (string memory) {
        uint256 acc;
        for (uint256 i = 0; i < type(uint256).max; ++i) {
            acc += sink[i];                  // unbounded cold reads
        }
        return string(abi.encodePacked(acc));
    }
    function version() external pure returns (string memory) {
        return "gasbomb";
    }
}

/// returns data that is not a valid ABI-encoded string
contract MalformedRenderer {
    function tokenURI(uint256) external pure returns (bytes32) {
        return bytes32(uint256(0xdeadbeef));
    }
    function version() external pure returns (string memory) {
        return "malformed";
    }
}

/// renders, but distinctly, so routing can be observed
contract MarkerRenderer is IFobalRenderer {
    string private mark;
    constructor(string memory m) {
        mark = m;
    }
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat(mark, ":", vmToString(tokenId));
    }
    function version() external pure returns (string memory) {
        return "marker";
    }
    function vmToString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf;
        while (v != 0) {
            buf = abi.encodePacked(uint8(48 + (v % 10)), buf);
            v /= 10;
        }
        return string(buf);
    }
}

contract RendererRouterTest is BaseFixture {
    FobalRendererRouter internal router;
    uint256[] internal ids;

    function setUp() public override {
        super.setUp();
        ids = mintSquadFor(alice, 1, 11);
        router = new FobalRendererRouter(admin, address(renderer));
    }

    // ---------------------------------------------- the no-op installation

    /// THE P1 CLAIM: installing the router changes no output byte.
    function test_router_isByteIdenticalNoOp() public view {
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(
                keccak256(bytes(router.tokenURI(ids[i]))),
                keccak256(bytes(renderer.tokenURI(ids[i]))),
                "router must be a byte-identical passthrough"
            );
        }
    }

    function test_install_leavesTokenUriUnchanged() public {
        string memory before = player.tokenURI(ids[0]);
        vm.prank(admin);
        player.setRenderer(IFobalRenderer(address(router)));
        assertEq(player.tokenURI(ids[0]), before, "swapping in the router must not change output");
    }

    function test_constructor_pointsBothLanesAtTheLiveRenderer() public view {
        assertEq(router.defaultRenderer(), address(renderer));
        assertEq(router.fallbackRenderer(), address(renderer));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(FobalRendererRouter.ZeroAddress.selector);
        new FobalRendererRouter(address(0), address(renderer));
        vm.expectRevert(FobalRendererRouter.ZeroAddress.selector);
        new FobalRendererRouter(admin, address(0));
    }

    // -------------------------------------------------------- totality

    function test_revertingRenderer_fallsBack() public {
        RevertingRenderer bad = new RevertingRenderer();
        vm.prank(admin);
        router.setDefaultRenderer(address(bad));
        // fallback still points at the good renderer
        assertEq(
            keccak256(bytes(router.tokenURI(ids[0]))),
            keccak256(bytes(renderer.tokenURI(ids[0]))),
            "a reverting default must fall through to the fallback"
        );
    }

    /// The gas-reserve proof. try/catch cannot catch out-of-gas; only an
    /// explicit gas cap on the attempt leaves enough to finish the job.
    function test_gasBomb_cannotTakeMetadataDown() public {
        GasBombRenderer bomb = new GasBombRenderer();
        vm.prank(admin);
        router.setDefaultRenderer(address(bomb));
        assertEq(
            keccak256(bytes(router.tokenURI(ids[0]))),
            keccak256(bytes(renderer.tokenURI(ids[0]))),
            "a gas-burning renderer must not deny the collection"
        );
    }

    function test_malformedReturn_fallsBack() public {
        MalformedRenderer junk = new MalformedRenderer();
        vm.prank(admin);
        router.setDefaultRenderer(address(junk));
        assertEq(
            keccak256(bytes(router.tokenURI(ids[0]))),
            keccak256(bytes(renderer.tokenURI(ids[0]))),
            "malformed return data must be treated as a failure, not decoded"
        );
    }

    /// The floor: with BOTH lanes broken, tokenURI still answers.
    function test_bothLanesBroken_returnsIdentityCard_neverReverts() public {
        RevertingRenderer bad = new RevertingRenderer();
        vm.startPrank(admin);
        router.setDefaultRenderer(address(bad));
        router.setFallbackRenderer(address(bad));
        vm.stopPrank();
        string memory uri = router.tokenURI(ids[0]);
        assertGt(bytes(uri).length, 0, "must still return something");
        assertEq(
            keccak256(bytes(_slice(uri, 0, 29))),
            keccak256("data:application/json;base64,"),
            "the card must still be a data-uri json document"
        );
    }

    function test_identityCard_survivesThroughThePlayerContract() public {
        RevertingRenderer bad = new RevertingRenderer();
        vm.startPrank(admin);
        router.setDefaultRenderer(address(bad));
        router.setFallbackRenderer(address(bad));
        player.setRenderer(IFobalRenderer(address(router)));
        vm.stopPrank();
        // the whole point: the collection's tokenURI does not revert
        assertGt(bytes(player.tokenURI(ids[0])).length, 0);
    }

    // --------------------------------------------------------- routing

    function test_resolutionOrder_pinBeatsCohortBeatsDefault() public {
        MarkerRenderer cohortR = new MarkerRenderer("cohort");
        MarkerRenderer pinR = new MarkerRenderer("pin");
        vm.startPrank(admin);
        assertEq(router.rendererFor(5), address(renderer), "default when nothing matches");
        router.setCohort(1, 11, address(cohortR));
        assertEq(router.rendererFor(5), address(cohortR), "cohort beats default");
        router.pin(5, address(pinR));
        assertEq(router.rendererFor(5), address(pinR), "pin beats cohort");
        assertEq(router.rendererFor(6), address(cohortR), "pin is per token only");
        router.pin(5, address(0));
        assertEq(router.rendererFor(5), address(cohortR), "unpinning restores the cohort");
        vm.stopPrank();
    }

    function test_newestCohortWins_andClearReverts() public {
        MarkerRenderer a = new MarkerRenderer("a");
        MarkerRenderer b = new MarkerRenderer("b");
        vm.startPrank(admin);
        router.setCohort(1, 11, address(a));
        router.setCohort(1, 11, address(b));
        assertEq(router.rendererFor(3), address(b), "later cohort wins");
        router.clearCohorts();
        assertEq(router.rendererFor(3), address(renderer), "clearing reverts to default");
        assertEq(router.cohortCount(), 0);
        vm.stopPrank();
    }

    function test_cohort_boundsAreInclusiveAndValidated() public {
        MarkerRenderer m = new MarkerRenderer("m");
        vm.startPrank(admin);
        router.setCohort(4, 6, address(m));
        assertEq(router.rendererFor(3), address(renderer));
        assertEq(router.rendererFor(4), address(m));
        assertEq(router.rendererFor(6), address(m));
        assertEq(router.rendererFor(7), address(renderer));
        vm.expectRevert(FobalRendererRouter.BadRange.selector);
        router.setCohort(0, 5, address(m));
        vm.expectRevert(FobalRendererRouter.BadRange.selector);
        router.setCohort(9, 8, address(m));
        vm.stopPrank();
    }

    /// tokenURI is a view every marketplace calls: the scan must stay bounded
    function test_cohortCount_isCapped() public {
        MarkerRenderer m = new MarkerRenderer("m");
        vm.startPrank(admin);
        for (uint256 i = 0; i < router.MAX_COHORTS(); ++i) {
            router.setCohort(1, 11, address(m));
        }
        vm.expectRevert(FobalRendererRouter.TooManyCohorts.selector);
        router.setCohort(1, 11, address(m));
        vm.stopPrank();
    }

    // ---------------------------------------------------- access control

    function test_onlyRouterAdmin_canReroute() public {
        MarkerRenderer m = new MarkerRenderer("m");
        bytes memory err = abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, bob, router.ROUTER_ADMIN_ROLE()
        );
        vm.startPrank(bob);
        vm.expectRevert(err);
        router.setDefaultRenderer(address(m));
        vm.expectRevert(err);
        router.setFallbackRenderer(address(m));
        vm.expectRevert(err);
        router.setCohort(1, 11, address(m));
        vm.expectRevert(err);
        router.pin(1, address(m));
        vm.expectRevert(err);
        router.clearCohorts();
        vm.stopPrank();
    }

    function test_rendererLanes_rejectZero() public {
        vm.startPrank(admin);
        vm.expectRevert(FobalRendererRouter.ZeroAddress.selector);
        router.setDefaultRenderer(address(0));
        vm.expectRevert(FobalRendererRouter.ZeroAddress.selector);
        router.setFallbackRenderer(address(0));
        vm.stopPrank();
    }

    function test_version() public view {
        assertEq(router.version(), "router-v1");
    }

    // ---- helper
    function _slice(string memory s, uint256 start, uint256 len) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = b[start + i];
        }
        return string(out);
    }
}
