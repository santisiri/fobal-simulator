// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {FobalRendererRouter} from "../src/FobalRendererRouter.sol";

interface IPlayerRead {
    function renderer() external view returns (address);
}

/// Deploys the router as a NO-OP in front of whatever renderer is currently
/// live. It reads the live pointer rather than taking it as a parameter, so
/// the deployment cannot be wired to a stale address.
///
///   FOBAL_PLAYER=0x…  FOBAL_ROUTER_ADMIN=0x…  \
///   forge script script/DeployRouter.s.sol --rpc-url base_sepolia \
///     --account fobal-admin --broadcast --verify
///
/// Installing it is a SEPARATE, deliberate transaction (see
/// docs/ROUTER_INSTALL.md) — deploying changes nothing on its own.
contract DeployRouter is Script {
    function run() external returns (FobalRendererRouter router) {
        address player = vm.envAddress("FOBAL_PLAYER");
        address admin = vm.envAddress("FOBAL_ROUTER_ADMIN");
        address liveRenderer = IPlayerRead(player).renderer();
        require(liveRenderer != address(0), "no live renderer to wrap");

        vm.startBroadcast();
        router = new FobalRendererRouter(admin, liveRenderer);
        vm.stopBroadcast();

        console2.log("router deployed     ", address(router));
        console2.log("wrapping renderer   ", liveRenderer);
        console2.log("router admin        ", admin);
        console2.log("NOT installed yet: prove parity, then setRenderer(router)");
    }
}
