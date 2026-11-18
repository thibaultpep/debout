"""Test de bout en bout : deux potes, une bande, un piège, la sonnerie, le défi, le fil."""
import re, sys, time, datetime
from playwright.sync_api import sync_playwright, expect

BASE = "http://localhost:8787/"
SHOTS = "/tmp/shots"
import os; os.makedirs(SHOTS, exist_ok=True)
errors = []


def shot(page, name):
    page.screenshot(path=f"{SHOTS}/{name}.png")


def watch(page, who):
    page.on("console", lambda m: m.type == "error" and errors.append(f"[{who}] {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"[{who}] PAGEERROR {e}"))


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=[
        "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    dev = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
               locale="fr-FR", timezone_id="Europe/Paris", permissions=["microphone"])
    A = b.new_context(**dev).new_page(); watch(A, "A")
    B = b.new_context(**dev).new_page(); watch(B, "B")

    # 1. Thibault crée son compte et sa bande
    A.goto(BASE)
    expect(A.locator(".wordmark")).to_be_visible()
    shot(A, "01_onboarding")
    A.fill("input[aria-label='Ton surnom']", "Thibault")
    A.click("button[aria-label='Avatar 🦊']")
    A.click("text=C'est parti")
    expect(A.locator(".top-title")).to_have_text("Mes potes")
    shot(A, "02_potes_vide")
    A.click("text=Créer une bande")
    A.fill("input[aria-label='Nom de la bande']", "Les loups")
    A.click("text=Créer la bande")
    expect(A.locator(".big-code")).to_be_visible()
    code = A.locator(".big-code").inner_text().strip()
    print("code bande", code)
    shot(A, "03_invite")
    A.click(".sheet .x")
    A.wait_for_timeout(400)

    # 2. Thibault met un réveil dans ~2 minutes
    A.click(".tab:has-text('Réveils')")
    A.click("text=Ajouter un réveil")
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=1)))
    fire = (now + datetime.timedelta(minutes=2)).replace(second=0, microsecond=0)
    A.fill("input[aria-label='Heure']", fire.strftime("%H:%M"))
    A.click("text=Tous les jours")
    A.fill("input[aria-label='Nom du réveil']", "Boulot")
    A.click(".sheet button.sound:has-text('Fanfare')")
    A.click("text=Ajouter le réveil")
    expect(A.locator(".alarm-time")).to_have_text(fire.strftime("%H:%M"))
    shot(A, "04_reveils")

    # 3. Max rejoint via le lien d'invitation
    B.goto(BASE + "?bande=" + code)
    expect(B.locator(".invite-note")).to_be_visible()
    B.fill("input[aria-label='Ton surnom']", "Max")
    B.click("button[aria-label='Avatar 🐸']")
    B.click("text=C'est parti")
    expect(B.locator(".band h2")).to_have_text("Les loups")
    expect(B.locator(".member:has-text('Thibault') .member-sub")).to_contain_text("Prochain réveil")
    shot(B, "05_potes_max")

    # 4. Max piège le réveil de Thibault (surprise de la semaine + message + vocal)
    B.click(".member:has-text('Thibault') >> text=Le réveiller")
    expect(B.locator(".sheet h2")).to_contain_text("Thibault")
    B.click(".weekly-pick")
    B.fill("textarea[aria-label='Message']", "Debout la marmotte, le café t'attend")
    B.click("text=Enregistrer un vocal")
    B.wait_for_timeout(2500)
    B.click("button:has-text('Arrêter')")
    expect(B.locator("button:has-text('Écouter')")).to_be_visible(timeout=8000)
    shot(B, "06_compose")
    B.locator(".sheet-body").evaluate("e => e.scrollTop = e.scrollHeight")
    shot(B, "06b_compose_bas")
    B.click("text=Poser le piège")
    expect(B.locator(".toast")).to_contain_text("Piège posé")
    B.wait_for_timeout(500)
    expect(B.locator(".member-trap")).to_be_visible()
    shot(B, "07_piege_pose")

    # 5. Thibault : le réveil apparaît comme piégé, puis il passe en mode dodo
    A.reload()
    A.wait_for_selector(".top-title")
    A.click(".tab:has-text('Réveils')") if A.locator(".top-title").inner_text() != "Mes réveils" else None
    expect(A.locator(".teaser").first).to_be_visible()
    shot(A, "08_reveil_piege")
    A.click("text=Lancer le mode dodo")
    expect(A.locator(".sleep")).to_be_visible()
    shot(A, "09_dodo")

    # 6. Ça sonne !
    A.wait_for_selector(".ring", timeout=200_000)
    A.wait_for_timeout(800)
    expect(A.locator(".ring-from")).to_contain_text("Max")
    expect(A.locator(".bubble-text")).to_contain_text("marmotte")
    expect(A.locator(".bubble-voice")).to_be_visible()
    playing = A.evaluate("() => [...document.querySelectorAll('audio')].length")
    shot(A, "10_sonnerie")
    # snooze une fois ? non : on teste le défi
    A.click("text=Je suis debout")
    A.wait_for_timeout(300)
    shot(A, "11_defi")
    chal = A.locator(".ring-zone").inner_text()
    print("défi :", chal.replace("\n", " | ")[:120])
    if A.locator(".chal-phrase").count():
        phrase = A.locator(".chal-phrase").inner_text().strip("« »  ")
        A.fill("input[aria-label='Recopie la phrase']", "faux")
        A.click(".chal-form button")
        A.fill("input[aria-label='Recopie la phrase']", phrase)
        A.click(".chal-form button")
    elif A.locator(".chal-tap").count():
        for _ in range(40): A.locator(".chal-tap").dispatch_event("pointerdown")
    expect(A.locator(".ring-title")).to_have_text("Bien joué", timeout=8000)
    shot(A, "12_bien_joue")
    A.click(".react-btn >> nth=0")
    A.click(".ring >> text=Fermer")
    A.wait_for_timeout(500)

    # 7. Le fil côté Max
    B.click(".tab:has-text('Le fil')")
    B.wait_for_timeout(1200)
    expect(B.locator(".events")).to_contain_text("levé")
    expect(B.locator(".events")).to_contain_text("😂")
    shot(B, "13_fil")

    # 8. Réveil surprise de Max à Thibault dans 1 min (sans réveil)
    B.click(".tab:has-text('Potes')")
    B.click(".member:has-text('Thibault') >> text=Le réveiller")
    B.click("text=Réveil surprise")
    s_at = (datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=1))) + datetime.timedelta(minutes=1, seconds=30)).replace(second=0)
    B.fill("input[aria-label='Heure du réveil surprise']", s_at.strftime("%H:%M"))
    B.click(".sheet button.sound:has-text('Klaxon')")
    B.click("text=Programmer le réveil surprise")
    expect(B.locator(".toast")).to_contain_text("surprise")
    A.click(".tab:has-text('Moi')")
    shot(A, "14_moi")
    A.reload(); A.wait_for_selector(".top-title")
    A.wait_for_selector(".ring", timeout=150_000)
    A.wait_for_timeout(600)
    expect(A.locator(".ring-from")).to_contain_text("Réveil surprise de")
    shot(A, "15_surprise")
    if A.locator("text=Lancer le réveil").count():
        A.click("text=Lancer le réveil")
    A.click("text=Snooze 5 min")
    A.wait_for_timeout(800)
    snz = A.evaluate("() => JSON.parse(localStorage.getItem('debout.snoozes'))")
    print("snoozes locaux :", len(snz), snz[0]["key"][:12] if snz else None)
    # on avance le snooze à maintenant : ça doit resonner
    A.evaluate("() => { const s = JSON.parse(localStorage.getItem('debout.snoozes')); s[0].fireAt = new Date(Date.now()-1000).toISOString(); localStorage.setItem('debout.snoozes', JSON.stringify(s)); }")
    A.reload(); A.wait_for_selector(".top-title"); A.click(".tab:has-text('Réveils')")
    A.wait_for_selector(".ring", timeout=70_000)
    expect(A.locator(".ring-from")).to_contain_text("Fin du snooze")
    shot(A, "16_fin_snooze")
    if A.locator("text=Lancer le réveil").count():
        A.click("text=Lancer le réveil")
    A.click("text=Je suis debout")
    expect(A.locator(".ring-title")).to_have_text("Bien joué", timeout=8000)
    expect(A.locator(".ring-from")).to_contain_text("snooze")
    A.click(".ring >> text=Fermer")
    B.reload(); B.wait_for_selector(".top-title")
    B.click(".tab:has-text('Le fil')"); B.wait_for_timeout(1000)
    expect(B.locator(".events")).to_contain_text("snoozé")
    shot(B, "17_fil_final")
    b.close()

print("ERREURS CONSOLE:", errors if errors else "aucune")
