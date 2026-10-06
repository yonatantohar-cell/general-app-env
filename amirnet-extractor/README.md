# amirnet-extractor

מחלץ את תוכן הסימולציות מ-amirnetwords.com לקבצי **JSON** מובנים ו-**Markdown** קריא.

## מצב נוכחי

הקוד בנוי ונבדק מקצה לקצה על HTML סינתטי, אבל **טרם הורץ מול האתר האמיתי**:
הדומיין `amirnetwords.com` חסום על ידי מדיניות הרשת של סביבת הענן
(ה-proxy מחזיר 403). הסלקטורים ב-`parse.js` הם גנריים וייתכן שידרשו כיול קצר
מול ה-HTML האמיתי — ראה [כיול](#כיול).

## שימוש

```bash
npm install

# מסלול א': הורדה מהאתר (דורש שהדומיין יהיה מותר ברשת)
node index.js --from-url https://amirnetwords.com/tests

# מסלול ב': מדפים ששמרת בעצמך (Ctrl+S בדפדפן)
node index.js --from-dir ./saved-pages

# אימות הפלט
node validate.js --expect 20
```

דגלים נוספים: `--refresh` (התעלם מה-cache), `--limit N` (נסה N דפים ראשונים).

## אבחון לפני חילוץ

לפני שמריצים חילוץ מלא, כדאי להריץ:

```bash
node inspect.js https://amirnetwords.com/tests
```

הכלי מדווח איפה התוכן באמת יושב — ב-HTML מהשרת, ב-JSON מוטמע, או שהדף הוא
קונכייה של אפליקציית JS שמביאה את התוכן מ-API. זה קובע את שיטת החילוץ, ולכן זה
השלב הראשון.

## מבנה

| קובץ | תפקיד |
|---|---|
| `fetch.js` | HTTP + **זיהוי קידוד**. אתרים בעברית מגישים לפעמים `windows-1255`; בלי פענוח נכון כל הטקסט יוצא ג'יבריש בלי שתיזרק שגיאה. כולל cache של HTML גולמי. |
| `parse.js` | HTML → אובייקטים. שלוש אסטרטגיות (radio inputs → קונטיינרים לפי class → טקסט ממוספר), בסדר אמינות יורד. |
| `render.js` | אובייקט → Markdown. שאלות קודם, מפתח תשובות בסוף כדי שהקובץ יהיה שמיש לתרגול. |
| `validate.js` | בדיקות שפיות. יוצא בקוד שגיאה, כך שאי אפשר להתעלם. |
| `inspect.js` | אבחון מבנה הדף. |
| `index.js` | מריץ הכל. |

## פלט

```
output/
├── json/simulation-01.json … simulation-20.json
├── all-simulations.json          כל הסימולציות בקובץ אחד
├── markdown/simulation-01.md …   + README.md עם אינדקס
└── errors.log                    רק אם משהו נכשל
```

סכמת שאלה. שדה שלא נמצא בדף **מושמט** ולא ממולא בערך מומצא:

```json
{
  "number": 1,
  "type": "sentence-completion",
  "prompt": "The committee decided to ___ the meeting.",
  "passage": "(רק בהבנת הנקרא)",
  "options": [{ "label": "A", "text": "postpone" }],
  "correctAnswer": "A",
  "explanation": "…"
}
```

## כיול

אם `inspect.js` מראה שהתוכן ב-HTML אבל החילוץ מחזיר 0 שאלות, או שהשאלות יוצאות
חלקיות — הכיול הוא ב-`parse.js` בלבד. כל שלוש האסטרטגיות מחזירות את שמן
(`radio-inputs`, `containers(.question)`, `text-pattern`), וההרצה מדפיסה איזו
מהן תפסה לכל דף, כך שרואים מיד מה צריך לתקן.

אם האתר מתגלה כאפליקציית JS, Chromium כבר מותקן בסביבה
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) — **אין להריץ `playwright install`**.

## התנהגות מול האתר

בקשות בטור עם השהייה של ~800ms ביניהן, retry עם backoff על 429/5xx, ושמירת ה-HTML
ב-cache כך שכיול ה-parser לא מייצר בקשות חדשות. סימולציה שנכשלת נרשמת ל-`errors.log`
וההרצה ממשיכה.
