// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {FobalArtLibrary} from "../../src/FobalArtLibrary.sol";
import {FobalArtConstants as K} from "../../src/art/FobalArtConstants.sol";
import {FobalFaceComposer} from "../../src/art/FobalFaceComposer.sol";
import {FobalKitComposer} from "../../src/art/FobalKitComposer.sol";
import {FobalKitRegistry} from "../../src/art/FobalKitRegistry.sol";
import {FobalRendererV2_1, IPlayerReader2} from "../../src/art/FobalRendererV2_1.sol";
import {FobalSquadRegistry} from "../../src/art/FobalSquadRegistry.sol";
import {FobalTraitEngine as TE} from "../../src/art/FobalTraitEngine.sol";
import {FobalRendererRouter} from "../../src/FobalRendererRouter.sol";
import {FobalTypes} from "../../src/interfaces/IFobalPlayer.sol";

/// the smallest thing the renderer will read a player out of
contract StubPlayer {
    bytes32 public dna;
    uint256 public appearance;

    constructor(bytes32 d, uint256 a) {
        dna = d;
        appearance = a;
    }

    function playerView(uint256) external view returns (FobalTypes.PlayerView memory v) {
        v.dna = dna;
        v.appearance = appearance;
        v.name = "Test Player";
        v.core.position = 2;
        v.core.level = 3;
    }
}

/// What an image actually COSTS to produce. The anchor system added five
/// classes, per-head translation, mirroring and skull clamping, and the router
/// reserves a fixed 250,000 gas to guarantee its fallback can still run after
/// a renderer call fails. That reserve is only meaningful if a real render
/// fits comfortably inside a node's eth_call budget, so measure it rather than
/// assume it.
contract RenderGasTest is Test {
    FobalRendererV2_1 internal renderer;
    bytes32[] internal fxDna;
    uint256[] internal fxAppearance;

    function _name(bytes32 k) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && k[n] != 0) ++n;
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) b[i] = k[i];
        return string(b);
    }

    function setUp() public {
        FobalArtLibrary art = new FobalArtLibrary(address(this));
        bytes32[] memory names = K.classNames();
        for (uint256 i; i < names.length; ++i) {
            string memory h =
                vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/blobs/", _name(names[i]), ".hex"));
            art.setClass(names[i], vm.parseBytes(vm.replace(h, "\n", "")));
        }
        renderer = new FobalRendererV2_1(
            IPlayerReader2(address(0)),
            new FobalFaceComposer(art),
            new FobalKitComposer(),
            FobalSquadRegistry(address(0)),
            FobalKitRegistry(address(0))
        );
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/art/gen/fixtures/render.json"));
        fxDna = vm.parseJsonBytes32Array(json, ".dna");
        fxAppearance = vm.parseJsonUintArray(json, ".appearance");
    }

    /// The router forwards `gasleft() - 250_000` and keeps the rest so its
    /// fallback card can always run. That means there is a caller gas budget
    /// below which a token silently renders the CARD instead of the player —
    /// and marketplaces choose that budget, not us. Find it.
    function test_reportTokenUriGasAndTheFallbackThreshold() public {
        StubPlayer player = new StubPlayer(fxDna[0], fxAppearance[0]);
        FobalRendererV2_1 real = new FobalRendererV2_1(
            IPlayerReader2(address(player)),
            renderer.faces(),
            renderer.kits(),
            FobalSquadRegistry(address(0)),
            FobalKitRegistry(address(0))
        );
        FobalRendererRouter router = new FobalRendererRouter(address(this), address(real));

        uint256 before = gasleft();
        string memory viaRouter = router.tokenURI(1);
        uint256 used = before - gasleft();
        console.log("tokenURI via router  ", used);
        console.log("uri bytes            ", bytes(viaRouter).length);

        // binary-search the caller budget at which the real art stops coming back
        bytes32 want = keccak256(bytes(viaRouter));
        uint256 lo = 100_000;
        uint256 hi = 12_000_000;
        for (uint256 k; k < 24; ++k) {
            uint256 mid = (lo + hi) / 2;
            (bool ok, bytes memory ret) =
                address(router).staticcall{gas: mid}(abi.encodeWithSignature("tokenURI(uint256)", uint256(1)));
            bool full = ok && ret.length > 0 && keccak256(bytes(abi.decode(ret, (string)))) == want;
            if (full) hi = mid; else lo = mid;
        }
        console.log("full art needs       ", hi);
        console.log("below that: the fallback identity card");

        // A CEILING, so a future change that doubles the cost fails here
        // rather than on a marketplace. 1.54M today against a 50M node cap for
        // eth_call is comfortable; 3M would still be, and anything past it
        // wants a deliberate decision rather than a silent drift.
        assertLt(used, 3_000_000, "tokenURI got much more expensive - was that intended?");
        assertLt(hi, 4_000_000, "the budget a caller needs for the real art crept up");
    }

    function test_reportImageGas() public view {
        uint256 total;
        uint256 worst;
        uint256 worstAt;
        uint256 n = fxDna.length;
        for (uint256 i; i < n; ++i) {
            FobalKitComposer.Kit memory kit = renderer.freeAgentKit(TE.seedOf(fxDna[i], fxAppearance[i]), 2);
            uint256 before = gasleft();
            renderer.imageWithKit(fxDna[i], fxAppearance[i], kit);
            uint256 used = before - gasleft();
            total += used;
            if (used > worst) { worst = used; worstAt = i; }
        }
        console.log("fixtures        ", n);
        console.log("mean gas        ", total / n);
        console.log("worst gas       ", worst);
        console.log("worst fixture   ", worstAt);
        console.log("router reserve  ", uint256(250_000));
        assertLt(worst, 2_000_000, "one image should stay well inside a node's eth_call budget");
    }
}
