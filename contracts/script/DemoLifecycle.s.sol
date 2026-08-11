// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Script.sol";
import {FobalDeployer} from "./FobalDeployer.sol";
import {FobalMatchEscrow} from "../src/FobalMatchEscrow.sol";
import {FobalTypes} from "../src/interfaces/IFobalPlayer.sol";
import {PlayerCodec} from "../src/libraries/PlayerCodec.sol";

/// @notice The complete development lifecycle against a local Anvil node:
/// deploy → configure → mint two teams → create match → stake ETH → sign
/// result → settle → progression → list → buy. Run with:
///   anvil &   (in another shell)
///   forge script script/DemoLifecycle.s.sol --rpc-url http://localhost:8545 --broadcast
/// Uses Anvil's well-known keys; NEVER use these on any real network.
contract DemoLifecycle is FobalDeployer {
    uint256 constant ADMIN_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant BOB_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant GEN_PK = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant ENGINE_PK = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    address internal alice = vm.addr(ALICE_PK);
    address internal bob = vm.addr(BOB_PK);
    Deployment internal d;

    function run() external {
        address admin = vm.addr(ADMIN_PK);

        vm.startBroadcast(ADMIN_PK);
        d = _deployAndWire(admin, admin, vm.addr(GEN_PK), vm.addr(ENGINE_PK));
        vm.stopBroadcast();
        console2.log("player deployed at", address(d.player));

        uint256[] memory aliceTeam = _mintSquad(alice, ALICE_PK, 1);
        uint256[] memory bobTeam = _mintSquad(bob, BOB_PK, 2);
        console2.log("squads minted; on-chain tokenURI bytes:", bytes(d.player.tokenURI(aliceTeam[0])).length);

        vm.broadcast(ALICE_PK);
        bytes32 matchId = d.escrow.createMatch{value: 1 ether}(
            FobalMatchEscrow.Mode.PROGRESSION,
            address(0),
            1 ether,
            keccak256("rules"),
            bob,
            1 days,
            1 days,
            1,
            aliceTeam
        );
        vm.broadcast(BOB_PK);
        d.escrow.joinMatch{value: 1 ether}(matchId, 2, bobTeam);
        console2.log("match locked; players committed");

        FobalTypes.PlayerProgress[] memory progs = new FobalTypes.PlayerProgress[](2);
        progs[0] = _progress(aliceTeam[9], 1);
        progs[1] = _progress(bobTeam[9], 2);
        FobalMatchEscrow.MatchResult memory result = FobalMatchEscrow.MatchResult({
            matchId: matchId,
            resultNonce: 1,
            teamA: 1,
            teamB: 2,
            scoreA: 2,
            scoreB: 1,
            replayHash: keccak256("replay"),
            statsRoot: keccak256("stats"),
            progressionHash: keccak256(abi.encode(progs)),
            deadline: block.timestamp + 1 hours
        });
        bytes32 digest = d.escrow.resultDigest(result);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENGINE_PK, digest);
        vm.broadcast(ALICE_PK);
        d.escrow.settle(result, abi.encodePacked(r, s, v), progs);
        console2.log("settled; striker career goals:", d.player.playerView(aliceTeam[9]).stats.goals);

        vm.broadcast(ALICE_PK);
        d.player.setApprovalForAll(address(d.market), true);
        vm.broadcast(ALICE_PK);
        d.market.list(aliceTeam[9], address(0), 5 ether, uint40(block.timestamp + 1 days));
        vm.broadcast(BOB_PK);
        d.market.buy{value: 5 ether}(aliceTeam[9]);
        console2.log("striker sold to bob; owner==bob:", d.player.ownerOf(aliceTeam[9]) == bob);
        console2.log("evolved XP survived the transfer:", d.player.playerView(aliceTeam[9]).core.xp);
    }

    function _mintSquad(address to, uint256 pk, uint64 teamId) internal returns (uint256[] memory ids) {
        FobalTypes.PlayerSeed[] memory seeds = new FobalTypes.PlayerSeed[](11);
        for (uint256 i; i < 11; ++i) {
            bytes32 dna = keccak256(abi.encodePacked(to, teamId, i));
            uint8 position = i == 0 ? 0 : uint8(1 + (i % 3));
            uint256 skills = _flat(55);
            if (position == 0) skills = PlayerCodec.setSkill(skills, 11, 85);
            seeds[i] = FobalTypes.PlayerSeed({
                name: string.concat("Player ", vm.toString(i + 1)),
                dna: dna,
                skills: skills,
                appearance: uint256(dna) & PlayerCodec.APPEARANCE_MASK,
                generation: 1,
                country: 32,
                position: position
            });
        }
        uint256 nonce = d.generator.nonces(to);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                d.generator.SQUAD_MINT_TYPEHASH(),
                to,
                teamId,
                uint32(1),
                nonce,
                deadline,
                keccak256(abi.encode(seeds))
            )
        );
        bytes32 digest = _domain(address(d.generator), "FobalPlayerGenerator", structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GEN_PK, digest);
        vm.broadcast(pk);
        ids = d.generator.mintSquad(to, teamId, 1, deadline, seeds, abi.encodePacked(r, s, v));
    }

    function _domain(address verifying, string memory name, bytes32 structHash)
        internal
        view
        returns (bytes32)
    {
        bytes32 sep = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", sep, structHash));
    }

    function _flat(uint8 value) internal pure returns (uint256 packed) {
        for (uint256 i; i < 12; ++i) {
            packed = PlayerCodec.setSkill(packed, i, value);
        }
    }

    function _progress(uint256 playerId, uint8 res) internal pure returns (FobalTypes.PlayerProgress memory) {
        return FobalTypes.PlayerProgress({
            playerId: playerId,
            delta: FobalTypes.ProgressionDelta({
                xp: 80,
                skillDeltas: PlayerCodec.setSkill(0, 1, 1),
                result: res,
                goals: 2,
                assists: 1,
                cleanSheet: false
            })
        });
    }
}
