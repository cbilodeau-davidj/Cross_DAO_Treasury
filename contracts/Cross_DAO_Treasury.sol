pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract CrossDaoTreasuryFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;
    mapping(uint256 => euint32) public encryptedTotalInvestment;
    mapping(uint256 => uint256) public numContributionsInBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed isPaused);
    event CooldownSecondsSet(uint256 indexed oldCooldownSeconds, uint256 indexed newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event InvestmentSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedAmount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalInvestment);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidSignature();
    error NotInitialized();
    error InvalidParameter();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; 
        currentBatchId = 1;
        emit BatchOpened(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidParameter();
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, _cooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();
        batchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) revert NotInitialized();
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function submitEncryptedInvestment(euint32 encryptedAmount) external onlyProvider whenNotPaused {
        uint256 currentTime = block.timestamp;
        if (currentTime - lastSubmissionTime[msg.sender] < cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        _initIfNeeded();
        _requireInitialized();

        lastSubmissionTime[msg.sender] = currentTime;

        if (numContributionsInBatch[currentBatchId] == 0) {
            encryptedTotalInvestment[currentBatchId] = encryptedAmount;
        } else {
            encryptedTotalInvestment[currentBatchId] = encryptedTotalInvestment[currentBatchId].add(encryptedAmount);
        }
        numContributionsInBatch[currentBatchId]++;

        emit InvestmentSubmitted(msg.sender, currentBatchId, encryptedAmount.toBytes32());
    }

    function requestBatchTotalDecryption(uint256 batchId) external onlyProvider whenNotPaused {
        uint256 currentTime = block.timestamp;
        if (currentTime - lastDecryptionRequestTime[msg.sender] < cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batchClosed[batchId] || batchId == 0) revert BatchClosedOrInvalid(); 

        _requireInitialized();

        lastDecryptionRequestTime[msg.sender] = currentTime;

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedTotalInvestment[batchId].toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        uint256 batchId = decryptionContexts[requestId].batchId;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = encryptedTotalInvestment[batchId].toBytes32();
        
        bytes32 currentHash = _hashCiphertexts(cts); 
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidSignature();
        }

        uint256 totalInvestment = abi.decode(cleartexts, (uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalInvestment);
    }
}