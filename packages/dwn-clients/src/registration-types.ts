/**
 * Proof-of-work challenge returned by `GET /registration/proof-of-work`.
 */
export type ProofOfWorkChallengeModel = {
  challengeNonce: string;
  maximumAllowedHashValue: string;
};

/**
 * Registration data included in the `POST /registration` request body.
 */
export type RegistrationData = {
  did: string;
  termsOfServiceHash: string;
};

/**
 * Full registration request body for `POST /registration`.
 */
export type RegistrationRequest = {
  proofOfWork: {
    challengeNonce: string;
    responseNonce: string;
  },
  registrationData: RegistrationData
};
