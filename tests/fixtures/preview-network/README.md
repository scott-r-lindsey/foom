# Preview network fixture

This publicly checked-in self-signed certificate and private key serve only the
isolated loopback HTTPS server in preview Electron tests. They are test data,
not credentials. The test trusts the certificate only for its preview partition
and loopback hostname; production certificate validation is unchanged.
