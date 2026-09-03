export type XWriteResult =
  | {
      status: 'sent';
      tweetId: string;
      url: string;
      verifiedBy: 'mutation-response' | 'read-after-write';
    }
  | { status: 'definitive-failure'; safeCode: string; httpStatus?: number }
  | { status: 'unknown'; safeCode: string; targetPostUrl: string };
