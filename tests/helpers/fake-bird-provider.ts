import type {
  ReplyVerificationResult,
  TargetPost,
  TargetPostResult,
  XAccountResult,
  XProviderDoctorResult,
  XReplyProvider,
  XWriteResult,
} from '../../src/reset/x/provider.js';

export const FAKE_TARGET_POST: TargetPost = {
  id: '100',
  authorHandle: 'thsottiaux',
  authorId: '42',
  createdAt: '2026-08-28T09:00:00.000Z',
  url: 'https://x.com/thsottiaux/status/100',
  selectionEvidence: {
    source: 'timeline',
    isPinned: false,
    isRetweet: false,
    isReply: false,
  },
};

export interface FakeBirdProviderOptions {
  targetResult?: TargetPostResult;
  accountResult?: XAccountResult;
  writeResult?: XWriteResult;
  verificationResult?: ReplyVerificationResult;
}

export class FakeBirdProvider implements XReplyProvider {
  beforeMutationStart?: () => Promise<void> | void;
  afterMutationStart?: () => Promise<void> | void;
  readonly calls = {
    doctor: 0,
    accountReads: 0,
    targetReads: 0,
    mutationAttempts: 0,
    verificationReads: 0,
  };

  private readonly options: Required<FakeBirdProviderOptions>;

  constructor(options: FakeBirdProviderOptions = {}) {
    this.options = {
      targetResult: options.targetResult ?? { status: 'found', post: FAKE_TARGET_POST },
      accountResult: options.accountResult ?? { ok: true, id: '7', handle: 'example' },
      writeResult:
        options.writeResult ??
        ({
          status: 'sent',
          tweetId: '9001',
          url: 'https://x.com/example/status/9001',
          verifiedBy: 'mutation-response',
        } satisfies XWriteResult),
      verificationResult: options.verificationResult ?? { status: 'not-verified', safeCode: 'no-match' },
    };
  }

  async doctor(): Promise<XProviderDoctorResult> {
    this.calls.doctor += 1;
    const account = this.options.accountResult;
    return account.ok
      ? { ok: true, safeCode: 'x-provider-ready', account: { id: account.id, handle: account.handle } }
      : { ok: false, safeCode: account.safeCode };
  }

  async getCurrentAccount(): Promise<XAccountResult> {
    this.calls.accountReads += 1;
    return this.options.accountResult;
  }

  async findTargetPost(): Promise<TargetPostResult> {
    this.calls.targetReads += 1;
    return this.options.targetResult;
  }

  async replyOnce(input: Parameters<XReplyProvider['replyOnce']>[0]): Promise<XWriteResult> {
    await this.beforeMutationStart?.();
    try {
      const startResult = await input.onMutationStart?.();
      if (startResult && !startResult.ok) {
        return { status: 'definitive-failure', safeCode: startResult.safeCode };
      }
    } catch {
      return { status: 'definitive-failure', safeCode: 'write-state-persistence-failed' };
    }
    await this.afterMutationStart?.();
    this.calls.mutationAttempts += 1;
    return this.options.writeResult;
  }

  async verifyReply(): Promise<ReplyVerificationResult> {
    this.calls.verificationReads += 1;
    return this.options.verificationResult;
  }
}
