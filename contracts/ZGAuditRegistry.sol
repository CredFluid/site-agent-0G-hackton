// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ZGAuditRegistry {
    struct ProofRecord {
        string runId;
        bytes32 targetUrlHash;
        bytes32 taskSetHash;
        bytes32 artifactHash;
        string storagePointer;
        uint16 overallScore;
        string agentId;
        uint64 completedAt;
        address submitter;
    }

    event ProofRegistered(
        bytes32 indexed proofId,
        string runId,
        bytes32 indexed targetUrlHash,
        bytes32 indexed artifactHash,
        string storagePointer,
        uint16 overallScore,
        string agentId,
        uint64 completedAt,
        address submitter
    );

    mapping(bytes32 => ProofRecord) private records;

    function registerProof(
        string calldata runId,
        bytes32 targetUrlHash,
        bytes32 taskSetHash,
        bytes32 artifactHash,
        string calldata storagePointer,
        uint16 overallScore,
        string calldata agentId,
        uint64 completedAt
    ) external returns (bytes32 proofId) {
        proofId = keccak256(abi.encode(runId, targetUrlHash, taskSetHash, artifactHash, storagePointer, msg.sender));
        require(records[proofId].completedAt == 0, "proof already registered");

        records[proofId] = ProofRecord({
            runId: runId,
            targetUrlHash: targetUrlHash,
            taskSetHash: taskSetHash,
            artifactHash: artifactHash,
            storagePointer: storagePointer,
            overallScore: overallScore,
            agentId: agentId,
            completedAt: completedAt,
            submitter: msg.sender
        });

        emit ProofRegistered(
            proofId,
            runId,
            targetUrlHash,
            artifactHash,
            storagePointer,
            overallScore,
            agentId,
            completedAt,
            msg.sender
        );
    }

    function getProof(bytes32 proofId) external view returns (ProofRecord memory) {
        return records[proofId];
    }
}
