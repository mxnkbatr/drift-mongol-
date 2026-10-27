# Drift King: Steppe Neon — App Store-д нийтлэх заавар

## Юу хэрэгтэй вэ

Энэ project одоогоор Three.js/Vite web game хэлбэртэй. App Store-д оруулахын тулд Mac компьютер дээр Xcode ашиглан iOS app wrapper үүсгэж, `dist` build-ийг Capacitor-ийн WKWebView дотор багцална. Capacitor iOS нь iOS 15+ болон Xcode 26+ шаарддаг бөгөөд `npx cap add ios`, `npx cap sync ios`, `npx cap open ios` командуудыг ашигладаг [1].

Apple Developer Program-д бүртгэлтэй байх шаардлагатай. Xcode дээр `Product > Archive` хийж, Archive Organizer-оос `Validate App`, дараа нь `Distribute App > TestFlight & App Store` сонгож upload хийнэ [2]. App Store Connect эхний build-ийг боловсруулсны дараа TestFlight дээр туршиж, эцсийн build-ийг App Review-д явуулна [3].

Энгийн website-ийг зүгээр л WebView-д боох нь Apple-ийн 4.2 Minimum Functionality шалгалтад эрсдэлтэй. Энэ app нь өөрөө ажилладаг local 3D тоглоом, touch controls, route/weather сонголт, local score, splash/icon, online leaderboard-той байх ёстой. Тайлбар болон review notes-д эдгээрийг тодорхой бичнэ [4].

## Ашиглах env утгууд

### 1. Backend/server env — Manus эсвэл өөр server дээр

Эдгээрийг iPhone app дотор болон GitHub-д хийхгүй.

```env
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DATABASE_NAME
PORT=8080
HOST=0.0.0.0
GAME_LEADERBOARD_READ_ONLY=0
```

`DATABASE_URL`-ийн жинхэнэ утгыг Manus-ийн server secret/environment хэсэгт хадгална. `DATABASE_URL`-ийг `.env`, GitHub, App Store binary дотор оруулж болохгүй. Database migration-ийг backend host дээр нэг удаа ажиллуулна:

```bash
node server/migrate.mjs
```

### 2. iOS/Capacitor project-ийн нэршил

Эдгээр нь secret биш, iOS project үүсгэхэд ашиглах утгууд:

```env
CAPACITOR_APP_NAME=Drift King: Steppe Neon
CAPACITOR_APP_ID=mn.driftking.steppe
IOS_BUNDLE_ID=mn.driftking.steppe
IOS_MIN_VERSION=15.0
IOS_ORIENTATION=landscape
```

`IOS_BUNDLE_ID` нь App Store Connect дээрх Bundle ID-тэй яг адил байх ёстой. `mn.driftking.steppe` нь санал болгосон утга; Apple Developer account дээр чөлөөтэй эсэхийг шалгаад ашиглана.

### 3. CI/App Store Connect upload env — зөвхөн CI secret store-д

Хэрэв GitHub Actions эсвэл Xcode Cloud-оор upload хийх бол эдгээрийг repository secret болгон хадгална. Private key-г хэзээ ч commit хийхгүй.

```env
APPLE_TEAM_ID=<Apple Developer Team ID>
APPLE_APP_STORE_CONNECT_KEY_ID=<App Store Connect API Key ID>
APPLE_ISSUER_ID=<App Store Connect API Issuer ID>
APPLE_PRIVATE_KEY_PATH=<CI secret file path, never a Git file>
```

Эдгээрийн бодит утгыг би тааж өгөх боломжгүй. Apple Developer account болон App Store Connect-оос өөрөө авна.

## Mac дээр хийх командууд

GitHub-оос хамгийн сүүлийн кодоо татна:

```bash
git clone https://github.com/mxnkbatr/drift-mongol-.git
cd drift-mongol-
pnpm install
pnpm build
```

Capacitor нэмнэ:

```bash
pnpm add @capacitor/core @capacitor/ios
pnpm add -D @capacitor/cli
npx cap init "Drift King: Steppe Neon" "mn.driftking.steppe" --web-dir=dist
npx cap add ios
npx cap sync ios
npx cap open ios
```

Xcode дээр дараахыг тохируулна:

1. `Signing & Capabilities` хэсэгт өөрийн Apple Team сонгоно.
2. Bundle Identifier-ийг `mn.driftking.steppe` эсвэл account дээр баталгаажсан ID болгоно.
3. Deployment Target-ийг iOS 15.0 эсвэл түүнээс дээш болгоно.
4. Device orientation-ийг Landscape Left/Right болгоно.
5. App icon-д `store/app-store/AppIcon-1024.png`-ийн asset-уудыг оруулна.
6. App нэрийг `Drift King: Steppe Neon` болгоно.
7. Real iPhone дээр touch control, landscape rotation, splash, leaderboard, offline mode-ийг шалгана.

## Анхаарах API асуудал

Одоогийн leaderboard client нь page-relative `/api/leaderboards/v1/` зам ашигладаг. iOS-ийн local Capacitor bundle дотор энэ зам нь Manus backend руу автоматаар очихгүй. App Store binary хийхээс өмнө хоёр сонголтын аль нэгийг хий:

- iOS wrapper-ийг production web origin-оор ажиллуулж, `/api/*`-г тэр origin дээр route хийх; эсвэл
- `VITE_API_BASE_URL=https://YOUR-PUBLISHED-GAME-DOMAIN` гэсэн build variable нэмээд leaderboard client-ийг production API origin ашигладаг болгох.

`YOUR-PUBLISHED-GAME-DOMAIN`-ийн бодит URL-ийг publish хийсний дараа Manus Dashboard-оос авна. Таамгаар URL бичиж болохгүй. Leaderboard ажиллахгүй байсан ч offline score attack ажиллах боловч App Review-д submission хийхээс өмнө online leaderboard-ийг production iPhone дээр шалга.

## App Store Connect дээр бөглөх зүйлс

`store/app-store-copy.md` доторх нэр, Mongolian/English description, keywords, screenshot caption-уудыг ашиглана. Мөн:

- Category: Games → Racing
- Orientation: Landscape
- Age rating: асуулгыг бодитоор бөглөж Apple-ийн эцсийн үнэлгээг авна
- App privacy: nickname болон leaderboard score-run statistics backend руу явдгийг тайлбарлана
- Privacy Policy URL: бодит public URL оруулна
- Support URL: бодит support/contact URL оруулна
- Review Notes: Монгол хэлний UI, 60 секундийн score attack, offline mode, route/weather picker, online leaderboard хэрхэн шалгахыг бичнэ
- Screenshots: iPhone landscape болон iPad landscape screenshots оруулна

Xcode дээр archive upload хийсний дараа App Store Connect build processing дуусахыг хүлээнэ. Эхлээд TestFlight internal tester-оор туршиж, дараа нь App Review-д явуулах нь зөв workflow [2] [3].

## Энэ project-ийн бэлэн asset-ууд

- App icon: `store/app-store/AppIcon-1024.png`
- Launch screen: `store/app-store/LaunchScreen-1242x2688.png`
- Listing copy: `store/app-store-copy.md`
- Source repository: `https://github.com/mxnkbatr/drift-mongol-`

## References

[1]: https://capacitorjs.com/docs/ios "Capacitor iOS Documentation"
[2]: https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases "Distributing your app for beta testing and releases"
[3]: https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/ "Upload builds in App Store Connect"
[4]: https://developer.apple.com/app-store/review/guidelines/ "App Review Guidelines"
