# معرفی ربات در تلگرام

<div dir="rtl">

متن‌هایی که برای پروفایل ربات در [@BotFather](https://t.me/BotFather) لازم است. هر متن را از داخل بلوک کد کپی کنید. یوزرنیم ربات هنوز انتخاب نشده؛ هر جا `@YourBot` آمده، یوزرنیم واقعی را بگذارید. عکس پروفایل و بنر را بعداً می‌شود مثل [ربات حسابدار](https://github.com/IsAmirMmd/inline-calculator-telegram/tree/main/branding) از روی HTML ساخت.

## ۱. اسم (Name)

دستور: `/setname`. همان اسمی که بالای چت دیده می‌شود. حداکثر ۶۴ کاراکتر.

</div>

```
دانلودر ساندکلاد 🎧
```

<div dir="rtl">

جایگزین‌ها: `ساندکلاد دانلودر | SoundCloud Downloader` · `🎧 دانلود از ساندکلاد`

## ۲. About

دستور: `/setabouttext`. روی صفحه‌ی پروفایل ربات دیده می‌شود. حداکثر ۱۲۰ کاراکتر.

</div>

```
🎧 لینک هر ترک ساندکلاد رو بفرست، فایل صوتی‌ش رو با اسم و کاور تحویل بگیر.
```

<div dir="rtl">

## ۳. Description

دستور: `/setdescription`. متنی که در چت خالی، قبل از «استارت»، زیر «What can this bot do?» می‌آید. حداکثر ۵۱۲ کاراکتر.

</div>

```
🎧 دانلود از ساندکلاد، همین‌جا توی تلگرام.

🔗 لینک ترک رو از اپ یا سایت ساندکلاد کپی کن (Share ← Copy link) و برام بفرست.
🎵 چند ثانیه بعد فایل صوتی با اسم، خواننده و کاور می‌رسه.

✅ لینک‌های on.soundcloud.com و ترک‌های خصوصی با لینک مخفی هم قبوله.
```

<div dir="rtl">

## ۴. دستورها (Commands)

لازم نیست دستی تنظیم شوند: هر دیپلوی و `/start` ادمین آن‌ها را با `setMyCommands` می‌فرستد (`syncCommands` در `tgcloud/lib/admin.js`). برای همه:

</div>

```
start - شروع و منوی ربات
help - راهنمای دانلود از ساندکلاد
```

<div dir="rtl">

## ۵. تنظیمات دیگر

- **Inline mode:** فعلاً خاموش بماند. حالت اینلاین در نقشه‌ی راه است ([`docs/SOUNDCLOUD.md`](../docs/SOUNDCLOUD.md#7-roadmap)).
- **Groups:** ربات فعلاً فقط در پی‌وی جواب می‌دهد. می‌شود `/setjoingroups` را روی `Disable` گذاشت تا وقتی گروه‌ها اضافه شوند.
- **Serverless → CLI Access → Access token:** توکن `tgcloud login` و سکرت `TGCLOUD_TOKEN` در GitHub. در چت یا کد نگذارید.

</div>
