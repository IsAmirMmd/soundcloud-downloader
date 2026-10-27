# جستجو از شورتکات آیفون

<div dir="rtl">

## چرا اندپوینت ربات نه

اندپوینت‌های ربات (`tgcloud/endpoints/*`، یعنی `POST https://app<id>.tgcloud.ai/api/<name>`) را پلتفرم تلگرام فقط وقتی اجرا می‌کند که درخواست **init data امضاشده‌ی تلگرام** داشته باشد. این امضا فقط داخل Mini App ربات و از داخل تلگرام ساخته می‌شود. شورتکات آن را ندارد، پس هر درخواستش قبل از رسیدن به کد ربات جواب `401` می‌گیرد. API عمومی دیگری هم روی tgcloud نیست. تنها راه دیگر، API مدیریت CLI است که با توکنی کار می‌کند که می‌تواند کد را دیپلوی و دیتابیس را عوض کند؛ آن توکن نباید روی گوشی برود.

پس شورتکات **خودش** از API ساندکلاد جستجو می‌کند (همان کاری که `lib/soundcloud.js` می‌کند) و آهنگ انتخاب‌شده را با یک لینک به ربات می‌دهد:

```
شورتکات ── GET soundcloud.com ─────────────▶ client_id (از HTML صفحه)
        ── GET api-v2 /search/tracks ──────▶ JSON نتیجه‌ها
        ── Choose from List
        ── Open URL tg://resolve?domain=<bot>&start=t_<id>
ربات    ◀─ /start t_<id> ──▶ همان مسیر دکمه‌ی نتیجه‌ی جستجو: ⏳ ← کانال کش ← فایل صوتی با ✏️ 🎤 🖼
```

هیچ توکن یا رمزی روی گوشی نیست. `client_id` عمومی است و هر بازدیدکننده‌ی soundcloud.com آن را می‌گیرد.

## ۱. گرفتن client_id

</div>

```
GET https://soundcloud.com/
User-Agent: Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0
```

<div dir="rtl">

بدنه ندارد. در HTML جواب این regex را پیدا کنید؛ گروه ۱ همان `client_id` است (۳۲ حرف و عدد):

</div>

```
"apiClient","data":\{"id":"([a-zA-Z0-9]{32})"
```

<div dir="rtl">

> **هدر User-Agent را حتماً بگذارید.** از سرور تلگرام (۲۰۲۶-۱۰-۲۷) با همین User-Agent صفحه‌ی ۷۴ کیلوبایتی با `client_id` آمد، ولی با User-Agent سافاری آیفون یک صفحه‌ی موبایل ۵۶ کیلوبایتی بدون آن. `client_id` هر چند هفته عوض می‌شود؛ هر بار اجرای شورتکات آن را تازه می‌گیرد.

## ۲. جستجو

</div>

```
GET https://api-v2.soundcloud.com/search/tracks?q=cry%20for%20me&limit=10&client_id=<client_id>
```

<div dir="rtl">

بدنه ندارد. `q` باید URL-encode شود (اکشن **URL Encode**). `limit` تعداد نتیجه است (ساندکلاد گاهی یکی بیشتر می‌دهد) و `offset` برای صفحه‌های بعد.

### نمونه‌ی جواب

جواب واقعی همین درخواست از سرور تلگرام، ۲۰۲۶-۱۰-۲۷، با `limit=2`، کوتاه‌شده: هر ترک حدود ۷۰ فیلد دارد و این‌جا فقط فیلدهای به‌دردبخور مانده‌اند؛ ساندکلاد یک ترک سوم هم داده بود که حذف شده؛ ترک دوم شش `transcodings` داشت که همه رمزگذاری‌شده بودند و دو تایش مانده است. `track_authorization` و `media.transcodings[].url` هم حذف شده‌اند (برای شورتکات لازم نیستند).

</div>

```json
{
  "collection": [
    {
      "kind": "track",
      "id": 1952913243,
      "title": "Ironmouse & Bubi - Cry For Me (WA WA WA) [Prod. Shirobeats & HalaCG]",
      "user": { "username": "shirobeats", "permalink_url": "https://soundcloud.com/shiro-beats" },
      "publisher_metadata": { "artist": "Ironmouse & Shirobeats & HalaCG" },
      "full_duration": 160679,
      "duration": 160691,
      "permalink_url": "https://soundcloud.com/shiro-beats/cry-for-me-wa-wa-wa-mix-4-wav",
      "artwork_url": "https://i1.sndcdn.com/artworks-DMZmJxpZrWxDqLfP-lrb91Q-large.jpg",
      "genre": "",
      "playback_count": 1905944,
      "likes_count": 32541,
      "policy": "MONETIZE",
      "media": {
        "transcodings": [
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "aac_96k",  "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "abr_sq",   "snipped": false, "format": { "protocol": "hls", "mime_type": "audio/mpegurl" } }
        ]
      }
    },
    {
      "kind": "track",
      "id": 2022483977,
      "title": "Cry For Me",
      "user": { "username": "The Weeknd", "permalink_url": "https://soundcloud.com/theweeknd" },
      "publisher_metadata": { "artist": "The Weeknd", "album_title": "Hurry Up Tomorrow" },
      "full_duration": 224183,
      "duration": 224183,
      "permalink_url": "https://soundcloud.com/theweeknd/cry-for-me",
      "artwork_url": "https://i1.sndcdn.com/artworks-H81byShFoRAy-0-large.jpg",
      "genre": "R & B",
      "label_name": "XO / Republic Records",
      "playback_count": 3968514,
      "likes_count": 94986,
      "policy": "MONETIZE",
      "media": {
        "transcodings": [
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "cbc-encrypted-hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } },
          { "preset": "aac_160k", "snipped": false, "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" } }
        ]
      }
    }
  ],
  "total_results": 377338,
  "next_href": "https://api-v2.soundcloud.com/search/tracks?query_urn=soundcloud%3Asearch%3A2b7e44a20e96406b8adeb41a7bb67d46&limit=2&offset=2&q=cry%20for%20me",
  "query_urn": "soundcloud:search:2b7e44a20e96406b8adeb41a7bb67d46"
}
```

<div dir="rtl">

| فیلد | یعنی |
|---|---|
| `collection[].id` | شناسه‌ی ترک؛ همان چیزی که به ربات داده می‌شود (`t_<id>`) |
| `title` | اسم ترک |
| `publisher_metadata.artist` | خواننده، وقتی ناشر گذاشته؛ وگرنه `user.username` |
| `full_duration` | مدت به **میلی‌ثانیه** (۱۶۰۶۷۹ ≈ ۲:۴۰) |
| `artwork_url` | کاور ۱۰۰×۱۰۰؛ با عوض کردن `-large` به `-t500x500` بزرگ‌تر می‌شود |
| `permalink_url` | صفحه‌ی ترک در ساندکلاد |
| `policy` | `BLOCK`: در دسترس نیست · `SNIP`: فقط پیش‌نمایش Go+ · بقیه پخش می‌شوند |
| `media.transcodings[].format.protocol` | `hls` یا `progressive`: ربات می‌تواند دانلودش کند. فقط `cbc-encrypted-hls` / `ctr-encrypted-hls`: رمزگذاری‌شده (DRM)، مثل Cry For Me از The Weeknd؛ ربات با پیام 🔒 جواب می‌دهد |
| `next_href` | صفحه‌ی بعد؛ برای صدا زدنش `&client_id=<client_id>` را به ته آن اضافه کنید. `null`: صفحه‌ی آخر |

خطاها: `401` یا `403` یعنی `client_id` منقضی شده (دوباره از قدم ۱ بگیرید). `429` یعنی ساندکلاد درخواست زیادی گرفته؛ کمی صبر کنید.

## ۳. دادن آهنگ به ربات

</div>

```
tg://resolve?domain=<BOT_USERNAME>&start=t_2022483977
```

<div dir="rtl">

(یا `https://t.me/<BOT_USERNAME>?start=t_2022483977`؛ `tg://` بدون رد شدن از سافاری مستقیم تلگرام را باز می‌کند.) `<BOT_USERNAME>` یوزرنیم ربات بدون @ است. تلگرام چت ربات را باز می‌کند و `/start t_2022483977` را می‌فرستد. اگر دکمه‌ی **Start / شروع** نشان داد، آن را بزنید. ربات همان کاری را می‌کند که با زدن روی یک نتیجه‌ی جستجو: «⏳»، بعد فایل صوتی با دکمه‌های ✏️ 🎤 🖼. ترکی که قابل دانلود نیست، دلیلش را می‌گیرد. در `/stats` این‌ها «t_ deep link» شمرده می‌شوند.

## ۴. ساختن شورتکات

اسم اکشن‌ها به انگلیسی است (در شورتکات فارسی هم با جستجوی همین اسم‌ها پیدا می‌شوند). هر اکشن خروجی قبلی را می‌گیرد، مگر این‌که متغیر نوشته شده باشد.

1. **Ask for Input**: نوع Text، سؤال «اسم آهنگ؟».
2. **URL Encode** (Encode) ← ورودی پرسیده‌شده. **Set Variable** `query`.
3. **Get Contents of URL**: `https://soundcloud.com/`، Method: GET، Headers: `User-Agent` = `Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0`.
4. **Match Text**: الگوی `"apiClient","data":\{"id":"([a-zA-Z0-9]{32})"` در خروجی قدم ۳.
5. **Get Group from Matched Text**: Group At Index `1`. **Set Variable** `clientId`.
   (اختیاری: **If** `clientId` **does not have any value** ← **Show Alert** «client_id پیدا نشد» و **Stop This Shortcut**.)
6. **Text**: `https://api-v2.soundcloud.com/search/tracks?q=` `query` `&limit=10&client_id=` `clientId` (بدون فاصله، پشت سر هم).
7. **Get Contents of URL** ← همان متن (GET). جواب JSON خودش Dictionary می‌شود.
8. **Get Dictionary Value**: Value for `collection`.
9. **Repeat with Each** آیتم:
   1. **Get Dictionary Value** `title` از Repeat Item ← **Set Variable** `title`.
   2. **Get Dictionary Value** `user` از Repeat Item، بعد **Get Dictionary Value** `username` ← **Set Variable** `artist`.
   3. **Get Dictionary Value** `id` از Repeat Item ← **Set Variable** `id`.
   4. **Text**: `title` ` — ` `artist` ` · #` `id`
   5. **Add to Variable** `results`.
10. **Choose from List** ← `results`.
11. **Match Text**: الگوی `#(\d+)$` در آیتم انتخاب‌شده، بعد **Get Group from Matched Text** Group At Index `1`.
12. **Open URLs**: `tg://resolve?domain=<BOT_USERNAME>&start=t_` + خروجی قدم ۱۱.

`#<id>` ته هر گزینه می‌آید تا بعد از انتخاب شناسه دوباره پیدا شود. نتیجه‌ها در یک لیست جمع می‌شوند، پس به همان ترتیب ساندکلاد نشان داده می‌شوند.

**اختیاری، مخفی کردن ترک‌های رمزگذاری‌شده:** داخل قدم ۹، قبل از Add to Variable: **Get Dictionary Value** `media` ← **Get Dictionary Value** `transcodings` ← **Repeat with Each** ← **Get Dictionary Value** `format` ← **Get Dictionary Value** `protocol` ← **If** is `hls` ← **Set Variable** `ok` = `1`. بعد از این Repeat داخلی: **If** `ok` is `1` ← Add to Variable، و بعد `ok` را خالی کنید. ربات بدون این هم ترک رمزگذاری‌شده را با پیام 🔒 رد می‌کند.

## ۵. تست از کامپیوتر

</div>

```
UA='Shortcuts/3 CFNetwork/1568.100.1 Darwin/24.0.0'
ID=$(curl -s -A "$UA" https://soundcloud.com/ | grep -oE '"apiClient","data":\{"id":"[a-zA-Z0-9]{32}"' | grep -oE '[a-zA-Z0-9]{32}')
curl -s -A "$UA" "https://api-v2.soundcloud.com/search/tracks?q=cry%20for%20me&limit=10&client_id=$ID" \
  | jq '.collection[] | {id, title, artist: (.publisher_metadata.artist // .user.username), seconds: (.full_duration / 1000 | floor), protocols: [.media.transcodings[].format.protocol] | unique}'
```

<div dir="rtl">

## بررسی از سرور تلگرام

همین مسیر (صفحه با regex شورتکات و هر دو User-Agent، بعد جستجو و JSON خامش) از جایی که ربات اجرا می‌شود:

</div>

```
Actions → Run in cloud → endpoints/adminProbe → { q: "cry for me", shortcut: true, limit: 2 }
```
