# iOS / Ionic release handoff

The Linux sandbox cannot generate or sign the native `ios/` Xcode workspace. Run these commands on a Mac after cloning the repository:

```bash
pnpm install
pnpm build
npx cap add ios
npx cap sync ios
npx cap open ios
```

Use `store/ios/AppStoreRelease.xcconfig.example` as the release settings template and `store/ios/ExportOptions-AppStore.plist.example` for command-line export. Replace only the placeholders on the Mac or in CI; never commit the real Team ID, certificates, provisioning profiles, App Store Connect API key, or private key.

## Apple items to create

1. Apple Developer Program membership.
2. An explicit App ID / Bundle ID: `mn.driftking.steppe`.
3. An App Store Connect app record using the same Bundle ID.
4. Automatic signing in Xcode, or a distribution certificate plus an App Store provisioning profile.
5. Optional CI upload credentials: App Store Connect API Key ID, Issuer ID, and the downloaded `.p8` private key stored as CI secrets.

## Xcode release settings

- Display name: `Drift King: Steppe Neon`
- Bundle ID: `mn.driftking.steppe`
- Deployment target: iOS 15.0+
- Orientation: Landscape Left and Landscape Right
- Version: `1.0.0`
- Build: `1`, increment for every uploaded build
- Team: your Apple Developer Team

Validate the archive on a real iPhone/iPad in landscape before uploading to TestFlight. The production leaderboard API must be reachable from the Capacitor app origin; see `store/APP-STORE-PUBLISHING-MN.md` for the API/CORS and database notes.
