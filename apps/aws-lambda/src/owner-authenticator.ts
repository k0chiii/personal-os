import type { ApiAuthenticator } from "@personal-os/api";

export const AUTHENTICATED_SUBJECT_HEADER = "x-personal-os-authenticated-subject";

export function ownerAuthenticator(ownerSubject: string): ApiAuthenticator {
  return {
    authenticate(request: Request) {
      const subject = request.headers.get(AUTHENTICATED_SUBJECT_HEADER)?.trim();
      return subject === ownerSubject ? { subject } : null;
    },
  };
}
