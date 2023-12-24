import { BigNumber, ethers, utils } from 'ethers'
import { GelatoRelay, CallWithSyncFeeERC2771Request } from "@gelatonetwork/relay-sdk";
import { addresses } from '../addresses';
import { signReceiveWithAuth } from "../sigUtils"
import mainnetTestForwarder from "../abi/lyra-selfpaying-mainnet.json";
import usdcAbi from "../abi/usdc.json";

// dot env
import dotenv from 'dotenv'
dotenv.config()

const RPC_URL = `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`

const OWNER_PK = process.env.OWNER_PRIVATE_KEY!

const networkConfig = addresses.mainnet

// This will be connected wallet in Metamask
const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
const user = new ethers.Wallet(OWNER_PK, provider);

const relay = new GelatoRelay();

// contract instances
const forwarder = new ethers.Contract(networkConfig.selfPayingForwarder, mainnetTestForwarder, user);

/**
 * npx ts-node examples/deposit/deposit-opbridge-selfpaying.ts
 * 
 */
async function run() {
  console.log('Depositing USDC with Gelato + Socket Vault', user.address)
  console.log('NetworkID:\t', (await (provider.getNetwork())).chainId)


  const usdc = new ethers.Contract(networkConfig.usdc, usdcAbi, user.provider)
  const balance = await usdc.balanceOf(user.address)
  console.log('Balance:\t', utils.formatUnits(balance, 6), 'USDC')

  const depositAmount = 30_000000;

  // calculate L2 safe address to deposit in, or it can be any recipient
  const toSCW = true

  // Build Permit data
  const now = Math.floor(Date.now() / 1000)
  const deadline = now + 86400;
  const {sig, nonce} = await signReceiveWithAuth(user, networkConfig.usdc, forwarder.address, depositAmount, now, deadline)
  
  // whole tx
  const minGas = '100000'
  const maxFeeUSDC = '20000000'
  const { data } = await forwarder.populateTransaction.depositUSDCSocketBridge(
    maxFeeUSDC, 
    toSCW, 
    minGas, 
    networkConfig.nativeConnector,
    {
    value: depositAmount,
    validAfter: now,
    validBefore: deadline,
    nonce: nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
  })

  const gasLimit = await provider.estimateGas({
    data,
    to: forwarder.address,
    from: '0xb539068872230f20456cf38ec52ef2f91af4ae49',
  });

  console.log('Gas Limit:\t', gasLimit.toString())
  
  // Populate a relay request
  const request: CallWithSyncFeeERC2771Request = {
    chainId: provider.network.chainId,
    target: forwarder.address,
    data: ethers.utils.hexlify(data as string),
    user: user.address,
    feeToken: networkConfig.usdc,
  };

  // retrieve the estimate fee from Gelato Fee Oracle
  const fee = await relay.getEstimatedFee(
    (await provider.getNetwork()).chainId,
    networkConfig.usdc,
    BigNumber.from(minGas),
    false,
  )

  // fee quote
  console.log(`Estimated Fee:\t${utils.formatUnits(fee.toString(), 6)} USDC`)

  const relayResponse = await relay.callWithSyncFeeERC2771(request, user);  
  
  // Print status
  console.log('Gelato Task:\t', `https://relay.gelato.digital/tasks/status/${relayResponse.taskId}`);

  for(let i = 1; i < 20; i++) {
    const status = await relay.getTaskStatus(relayResponse.taskId);
    if (status?.taskState === "CheckPending" ||  status?.taskState === "ExecPending" || status?.taskState === "WaitingForConfirmation") {
      console.log('Task Status:\t', status?.taskState);
      await new Promise(r => setTimeout(r, 2000));
      continue  
    }
    
    // All non waiting states:
    console.log('Task Status:\t', status?.taskState);
    if (status?.transactionHash) {
      console.log('Transaction Hash:\t', status?.transactionHash);
    } 
    break
  }

  const balanceAfter = await usdc.balanceOf(user.address)
  console.log('New Balance:\t', utils.formatUnits(balanceAfter, 6), 'USDC')
}


run();