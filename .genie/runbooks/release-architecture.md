# Release architecture — cosign owner-of-record

`sign-attest.yml` is the cosign owner-of-record. The OIDC SAN URI for binary tarballs is bound to this file path. Cosign installer version: v2.4.1 (canonical). Future workflow files MUST NOT introduce another cosign step — duplicate cosign callers would fork the trust root.
