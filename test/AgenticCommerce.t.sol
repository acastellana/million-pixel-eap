// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/AgenticCommerce.sol";

contract AgenticCommerceTest is Test {
    AgenticCommerce public ac;
    address client = address(0xC11E47);
    address provider = address(0xBEEF);
    address evaluator = address(0xEA10);
    
    function setUp() public {
        // BRIDGE_RECEIVER = evaluator addr for tests; ORACLE_RELAYER = same
        ac = new AgenticCommerce(evaluator, evaluator);
        vm.deal(client, 100 ether);
    }
    
    function testCreateJob() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        (address _client,,,,,,,,) = ac.jobs(jobId);
        assertEq(_client, client);
    }

    function testSetProvider() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        
        vm.prank(client);
        ac.setProvider(jobId, provider);
        
        (,address _provider,,,,,,,) = ac.jobs(jobId);
        assertEq(_provider, provider);
    }

    function testSetBudget() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        
        (,,,uint256 budget,,,,,) = ac.jobs(jobId);
        assertEq(budget, 1 ether);

        // Provider should also be able to set budget
        vm.prank(client);
        ac.setProvider(jobId, provider);

        vm.prank(provider);
        ac.setBudget(jobId, 2 ether);
        (,,,budget,,,,,) = ac.jobs(jobId);
        assertEq(budget, 2 ether);
    }

    function testFund() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        
        vm.prank(client);
        ac.setProvider(jobId, provider);
        
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        
        vm.prank(client);
        ac.fund{value: 1 ether}(jobId, 1 ether);
        
        (,,,,,AgenticCommerce.JobStatus status,,,) = ac.jobs(jobId);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Funded));
    }

    function testFundProtection() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        
        vm.prank(client);
        ac.setProvider(jobId, provider);
        
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        
        // Should fail if expected budget is wrong
        vm.prank(client);
        vm.expectRevert("Budget mismatch");
        ac.fund{value: 1 ether}(jobId, 2 ether);

        // Should fail if provider is not set
        vm.prank(client);
        bytes32 jobId2 = ac.createJob(evaluator, block.timestamp + 1 days, "test job 2", address(0));
        
        vm.prank(client);
        vm.expectRevert("Provider not set");
        ac.fund{value: 1 ether}(jobId2, 0);
    }

    function testSubmit() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        vm.prank(client);
        ac.setProvider(jobId, provider);
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        vm.prank(client);
        ac.fund{value: 1 ether}(jobId, 1 ether);

        vm.prank(provider);
        ac.submit(jobId, "ipfs://result");
        
        (,,,,,AgenticCommerce.JobStatus status,,, ) = ac.jobs(jobId);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Submitted));
    }

    function testComplete() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        vm.prank(client);
        ac.setProvider(jobId, provider);
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        vm.prank(client);
        ac.fund{value: 1 ether}(jobId, 1 ether);
        vm.prank(provider);
        ac.submit(jobId, "ipfs://result");

        uint256 initialProviderBalance = provider.balance;
        vm.prank(evaluator);
        ac.complete(jobId);
        
        (,,,,,AgenticCommerce.JobStatus status,,, ) = ac.jobs(jobId);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Completed));
        assertEq(provider.balance, initialProviderBalance + 1 ether);
    }

    function testReject() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        
        // Client can reject when Open
        vm.prank(client);
        ac.reject(jobId, "Cancelled by client");
        (,,,,,AgenticCommerce.JobStatus status,,, ) = ac.jobs(jobId);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Rejected));

        // Evaluator can reject when Funded or Submitted
        vm.prank(client);
        bytes32 jobId2 = ac.createJob(evaluator, block.timestamp + 1 days, "test job 2", address(0));
        vm.prank(client);
        ac.setProvider(jobId2, provider);
        vm.prank(client);
        ac.setBudget(jobId2, 1 ether);
        vm.prank(client);
        ac.fund{value: 1 ether}(jobId2, 1 ether);

        vm.prank(evaluator);
        ac.reject(jobId2, "Not good enough");
        (,,,,,status,,, ) = ac.jobs(jobId2);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Rejected));
    }

    function testClaimRefund() public {
        vm.prank(client);
        bytes32 jobId = ac.createJob(evaluator, block.timestamp + 1 days, "test job", address(0));
        vm.prank(client);
        ac.setProvider(jobId, provider);
        vm.prank(client);
        ac.setBudget(jobId, 1 ether);
        vm.prank(client);
        ac.fund{value: 1 ether}(jobId, 1 ether);

        // Warp to after expiry
        vm.warp(block.timestamp + 2 days);

        uint256 initialClientBalance = client.balance;
        // Anyone can call it (using address(0xABCD) as "anyone")
        vm.prank(address(0xABCD));
        ac.claimRefund(jobId);
        
        (,,,,,AgenticCommerce.JobStatus status,,, ) = ac.jobs(jobId);
        assertEq(uint(status), uint(IAgenticCommerce.JobStatus.Expired));
        assertEq(client.balance, initialClientBalance + 1 ether);
    }

    function testCreatePixelJob() public {
        vm.prank(client);
        bytes32 jobId = ac.createPixelJob(block.timestamp + 1 days, 10, 20, 100, 100, "img", "link", address(0));
        
        (address _client,,,,,,string memory description,,) = ac.jobs(jobId);
        assertEq(_client, client);
        assertEq(description, "PIXEL_PLACEMENT:10,20,100x100|img|link");
    }
}
