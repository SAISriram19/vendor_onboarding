"""Generate realistic sample PDF documents for the demo.

Produces, in samples/docs/:
  helvetia_incorp.pdf          text-layer incorporation certificate (good)
  helvetia_bank.pdf            text-layer bank confirmation, IBAN matches 01_happy_path
  helvetia_bank_scanned.pdf    IMAGE-ONLY bank letter (no text layer -> forces OCR)
  wrong_bank.pdf               text-layer bank letter with a DIFFERENT IBAN (contradiction)
"""
import os

import fitz
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
os.makedirs(DOCS, exist_ok=True)
FONT = r"C:\Windows\Fonts\arial.ttf"


def text_pdf(path, lines):
    c = canvas.Canvas(path, pagesize=A4)
    y = 790
    for ln in lines:
        c.setFont("Helvetica-Bold" if ln.endswith("::") else "Helvetia" if False else "Helvetica",
                  14 if ln.endswith("::") else 11)
        c.drawString(60, y, ln.rstrip(":"))
        y -= 22
    c.save()


def scanned_pdf(path, lines):
    """Render text to a bitmap, embed as a full-page image -> no text layer."""
    W, H = 1240, 1754  # ~150 dpi A4
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    title = ImageFont.truetype(FONT, 40)
    body = ImageFont.truetype(FONT, 30)
    y = 90
    for ln in lines:
        d.text((90, y), ln, fill=(15, 15, 15), font=title if ln.endswith("::") else body)
        y += 56 if ln.endswith("::") else 46
    png = path + ".png"
    img.save(png)
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=png)
    doc.save(path)
    doc.close()
    os.remove(png)


incorp = [
    "CERTIFICATE OF INCORPORATION::",
    "Handelsregister - Amtsgericht Munich",
    "",
    "Company: Helvetia Precision Tools GmbH",
    "Registered office: Industriestrasse 12, 80331 Munich",
    "Country: Germany",
    "Registration number: HRB 209114",
    "Date of incorporation: 14 March 2016",
]
bank_good = [
    "DEUTSCHE BANK - ACCOUNT CONFIRMATION::",
    "",
    "We confirm the following account:",
    "Account holder: Helvetia Precision Tools GmbH",
    "Bank: Deutsche Bank AG",
    "IBAN: DE75 5121 0800 1245 1261 99",
    "BIC: DEUTDEDBMUC",
    "Date: 02 June 2026",
]
bank_wrong = [
    "VOLKSBANK - ACCOUNT CONFIRMATION::",
    "",
    "We confirm the following account:",
    "Account holder: Helvetia Precision Tools GmbH",
    "Bank: Volksbank Munich",
    "IBAN: DE12 5001 0517 0648 4898 90",
    "BIC: GENODEF1M01",
    "Date: 02 June 2026",
]

zoho_incorp = [
    "CERTIFICATE OF INCORPORATION::",
    "Ministry of Corporate Affairs - Registrar of Companies",
    "",
    "Company: Zoho Corporation Private Limited",
    "Registered office: Estancia IT Park, Chennai, Tamil Nadu",
    "Country: India",
    "CIN: U72200TN1996PTC035739",
    "GSTIN: 33AAACZ4321Q1Z3",
    "Date of incorporation: 17 March 1996",
]
zoho_bank = [
    "ICICI BANK - ACCOUNT CONFIRMATION::",
    "",
    "We confirm the following account:",
    "Account holder: Zoho Corporation Private Limited",
    "Bank: ICICI Bank Limited",
    "IBAN: IN80ICIC000445510293847",
    "IFSC: ICIC0004455",
    "Date: 22 June 2026",
]

text_pdf(os.path.join(DOCS, "helvetia_incorp.pdf"), incorp)
text_pdf(os.path.join(DOCS, "helvetia_bank.pdf"), bank_good)
scanned_pdf(os.path.join(DOCS, "helvetia_bank_scanned.pdf"), bank_good)
text_pdf(os.path.join(DOCS, "wrong_bank.pdf"), bank_wrong)
text_pdf(os.path.join(DOCS, "zoho_incorp.pdf"), zoho_incorp)
text_pdf(os.path.join(DOCS, "zoho_bank.pdf"), zoho_bank)
print("Wrote:", sorted(os.listdir(DOCS)))
