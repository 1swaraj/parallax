// How the relayer waits for its transactions' receipts (waitForReceipt): one request a block, for the receipt only.

import {
  keccak256,
  toHex,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type TransactionReceipt,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicClient, waitForReceipt } from '../src/lib/server/chain';

const hash = keccak256(toHex('a relayed transaction'));
const receipt = { transactionHash: hash, status: 'success' } as TransactionReceipt;
const notYet = () => new TransactionReceiptNotFoundError({ hash });

describe('waitForReceipt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('asks for the receipt once a block until it’s in, and for nothing else', async () => {
    vi.useFakeTimers();
    const getReceipt = vi
      .spyOn(publicClient, 'getTransactionReceipt')
      .mockRejectedValueOnce(notYet())
      .mockResolvedValueOnce(receipt);
    // Block numbers or transaction lookups, as viem's wait makes.
    const otherRequests = vi.spyOn(publicClient, 'request');
    const waiting = waitForReceipt(hash);
    await vi.advanceTimersByTimeAsync(publicClient.pollingInterval);
    expect(getReceipt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(publicClient.pollingInterval);
    await expect(waiting).resolves.toBe(receipt);
    expect(getReceipt).toHaveBeenCalledTimes(2);
    expect(otherRequests).not.toHaveBeenCalled();
  });

  it('gives up after its timeout, as viem’s wait does', async () => {
    vi.useFakeTimers();
    vi.spyOn(publicClient, 'getTransactionReceipt').mockRejectedValue(notYet());
    const outcome = expect(waitForReceipt(hash, 2_000)).rejects.toBeInstanceOf(
      WaitForTransactionReceiptTimeoutError
    );
    await vi.advanceTimersByTimeAsync(2_000 + publicClient.pollingInterval);
    await outcome;
  });

  it('passes on errors other than a receipt not in yet', async () => {
    vi.useFakeTimers();
    vi.spyOn(publicClient, 'getTransactionReceipt').mockRejectedValue(new Error('RPC down'));
    const outcome = expect(waitForReceipt(hash)).rejects.toThrow('RPC down');
    await vi.advanceTimersByTimeAsync(publicClient.pollingInterval);
    await outcome;
  });
});
