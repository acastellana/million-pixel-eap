// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAgenticCommerce
 * @dev Interface for EIP-8183 Agentic Commerce Protocol
 */
interface IAgenticCommerce {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    event JobCreated(bytes32 indexed jobId, address indexed client, address evaluator, uint256 budget, string description);
    event ProviderAssigned(bytes32 indexed jobId, address indexed provider);
    event JobFunded(bytes32 indexed jobId, uint256 amount);
    event JobSubmitted(bytes32 indexed jobId, string resultLocation);
    event JobCompleted(bytes32 indexed jobId);
    event JobRejected(bytes32 indexed jobId, string reason);
    event RefundClaimed(bytes32 indexed jobId, uint256 amount);

    function createJob(address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (bytes32);
    function setProvider(bytes32 jobId, address provider) external;
    function setBudget(bytes32 jobId, uint256 budget) external;
    function fund(bytes32 jobId, uint256 expectedBudget) external payable;
    function submit(bytes32 jobId, string calldata resultLocation) external;
    function complete(bytes32 jobId) external;
    function reject(bytes32 jobId, string calldata reason) external;
    function claimRefund(bytes32 jobId) external;
}

/**
 * @title IACPHook
 * @dev Optional hook interface for EIP-8183
 */
interface IACPHook {
    function onJobCreated(bytes32 jobId) external;
    function onJobFunded(bytes32 jobId) external;
    function onJobSubmitted(bytes32 jobId) external;
    function onJobCompleted(bytes32 jobId) external;
}

/**
 * @title AgenticCommerce
 * @dev Implementation of EIP-8183 for the Million Pixel Homepage
 */
contract AgenticCommerce is IAgenticCommerce {
    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        string description;
        string resultLocation;
        address hook;
    }

    mapping(bytes32 => Job) public jobs;
    uint256 public jobCount;

    modifier onlyClient(bytes32 jobId) {
        require(msg.sender == jobs[jobId].client, "Not client");
        _;
    }

    modifier onlyProvider(bytes32 jobId) {
        require(msg.sender == jobs[jobId].provider, "Not provider");
        _;
    }

    modifier onlyEvaluator(bytes32 jobId) {
        require(msg.sender == jobs[jobId].evaluator, "Not evaluator");
        _;
    }

    function _createJob(
        address client,
        address evaluator,
        uint256 expiredAt,
        string memory description,
        address hook
    ) internal returns (bytes32) {
        bytes32 jobId = keccak256(abi.encodePacked(block.timestamp, client, jobCount++));
        
        jobs[jobId] = Job({
            client: client,
            provider: address(0),
            evaluator: evaluator,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            description: description,
            resultLocation: "",
            hook: hook
        });

        emit JobCreated(jobId, client, evaluator, 0, description);
        
        if (hook != address(0)) {
            IACPHook(hook).onJobCreated(jobId);
        }

        return jobId;
    }

    function createJob(
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external override returns (bytes32) {
        return _createJob(msg.sender, evaluator, expiredAt, description, hook);
    }

    function createPixelJob(
        address evaluator,
        uint256 expiredAt,
        uint256 pixelX,
        uint256 pixelY,
        uint256 blockWidth,
        uint256 blockHeight,
        string calldata imageUrl,
        string calldata linkUrl,
        address hook
    ) external returns (bytes32) {
        string memory description = string(abi.encodePacked(
            "PIXEL_PLACEMENT:", 
            uint2str(pixelX), ",", uint2str(pixelY), ",", 
            uint2str(blockWidth), "x", uint2str(blockHeight), "|", 
            imageUrl, "|", linkUrl
        ));
        
        return _createJob(msg.sender, evaluator, expiredAt, description, hook);
    }

    function setProvider(bytes32 jobId, address provider) external override onlyClient(jobId) {
        require(jobs[jobId].status == JobStatus.Open, "Not open");
        jobs[jobId].provider = provider;
        emit ProviderAssigned(jobId, provider);
    }

    function setBudget(bytes32 jobId, uint256 budget) external override {
        require(msg.sender == jobs[jobId].client || msg.sender == jobs[jobId].provider, "Not authorized");
        require(jobs[jobId].status == JobStatus.Open, "Not open");
        jobs[jobId].budget = budget;
    }

    function fund(bytes32 jobId, uint256 expectedBudget) external payable override onlyClient(jobId) {
        require(jobs[jobId].status == JobStatus.Open, "Not open");
        require(jobs[jobId].provider != address(0), "Provider not set");
        require(jobs[jobId].budget == expectedBudget, "Budget mismatch");
        require(msg.value >= jobs[jobId].budget, "Insufficient funds");
        
        jobs[jobId].status = JobStatus.Funded;
        emit JobFunded(jobId, msg.value);

        if (jobs[jobId].hook != address(0)) {
            IACPHook(jobs[jobId].hook).onJobFunded(jobId);
        }
    }

    function submit(bytes32 jobId, string calldata resultLocation) external override onlyProvider(jobId) {
        require(jobs[jobId].status == JobStatus.Funded, "Not funded");
        
        jobs[jobId].status = JobStatus.Submitted;
        jobs[jobId].resultLocation = resultLocation;
        emit JobSubmitted(jobId, resultLocation);

        if (jobs[jobId].hook != address(0)) {
            IACPHook(jobs[jobId].hook).onJobSubmitted(jobId);
        }
    }

    function complete(bytes32 jobId) external override onlyEvaluator(jobId) {
        require(jobs[jobId].status == JobStatus.Submitted, "Not submitted");
        
        jobs[jobId].status = JobStatus.Completed;
        uint256 amount = jobs[jobId].budget;
        jobs[jobId].budget = 0;
        payable(jobs[jobId].provider).transfer(amount);
        emit JobCompleted(jobId);

        if (jobs[jobId].hook != address(0)) {
            IACPHook(jobs[jobId].hook).onJobCompleted(jobId);
        }
    }

    function reject(bytes32 jobId, string calldata reason) external override {
        Job storage job = jobs[jobId];
        if (msg.sender == job.client) {
            require(job.status == JobStatus.Open, "Client can only reject when Open");
        } else if (msg.sender == job.evaluator) {
            require(job.status == JobStatus.Funded || job.status == JobStatus.Submitted, "Evaluator cannot reject in this state");
        } else {
            revert("Not authorized to reject");
        }
        
        job.status = JobStatus.Rejected;
        emit JobRejected(jobId, reason);
    }

    function claimRefund(bytes32 jobId) external override {
        require(block.timestamp > jobs[jobId].expiredAt, "Not expired");
        require(jobs[jobId].status != JobStatus.Completed && jobs[jobId].status != JobStatus.Expired, "Cannot refund");
        
        uint256 amount = jobs[jobId].budget;
        jobs[jobId].budget = 0;
        jobs[jobId].status = JobStatus.Expired;
        
        payable(jobs[jobId].client).transfer(amount);
        emit RefundClaimed(jobId, amount);
    }

    // Helper for string conversion
    function uint2str(uint256 _i) internal pure returns (string memory _uintAsString) {
        if (_i == 0) {
            return "0";
        }
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - (_i / 10) * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }

    receive() external payable {}
}
