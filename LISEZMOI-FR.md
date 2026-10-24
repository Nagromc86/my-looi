# My LOOI — version française

Fork de [razor79/my-looi](https://github.com/razor79/my-looi) (licence MIT) avec le français ajouté.

## Ce qui change

- **Interface en français** (choix « Français » dans Réglages → Langue, automatique si le téléphone est en français).
- **LOOI répond en français** et s'attend à ce que tu parles français (réglable séparément avec 🎙 et 🔊 sur l'écran principal).
- **Nom par défaut : « LOOI »**, et il répond aussi à « Louis » et « Robot ».
- **Commandes vocales en français**, y compris un modèle de reconnaissance hors ligne français pour le mode conduite.

## Choix de l'IA : Gemini (gratuit) ou OpenAI (payant)

Par défaut, LOOI discute avec **Gemini Live** de Google, qui a un niveau gratuit.

1. Va sur **https://aistudio.google.com/apikey** (connecte-toi avec ton compte Google).
2. Appuie sur **Create API key** et copie la clé (elle commence par `AIza`).
3. Dans l'app, à la première configuration (ou Réglages → Moteur d'IA), colle-la et enregistre.

Bon à savoir :
- Le niveau gratuit a des limites d'utilisation par minute et par jour ; si elles sont atteintes, LOOI le signale et il suffit de réessayer plus tard.
- Sur le niveau gratuit, Google peut utiliser les conversations pour améliorer ses produits.
- Les longues conversations sont reprises automatiquement quand Google renouvelle la connexion (toutes les ~10 minutes).
- La voix se choisit dans Réglages → Voix de LOOI (Puck par défaut).

OpenAI reste disponible dans Réglages → Moteur d'IA (payant, avec ta clé OpenAI).

## Commandes vocales

En conversation, commence par le nom du robot : « Louis, avance ».

| Action | Exemples |
|---|---|
| Avancer | avance, en avant, tout droit |
| Reculer | recule, en arrière, marche arrière |
| Tourner | tourne à gauche, à droite, va à gauche |
| Demi-tour | fais demi-tour, retourne-toi |
| Hocher la tête | hoche la tête, hoche la tête deux fois, fais oui |
| Danser | danse, fais une danse |
| Dormir | va dormir, dors, fais dodo |
| **Arrêt d'urgence** (sans le nom) | **stop**, **arrête**, arrête-toi, ne bouge plus |

Changer de langue à la voix : « Parle en anglais », « Réponds en français », « Écoute en français ».

## Construire l'APK

Le workflow `.github/workflows/build-apk-fr.yml` construit l'APK sur GitHub et le publie dans **Releases** (`my-looi-fr.apk`).

La clé de signature permanente est stockée chiffrée dans `signing/`. Le workflow la déverrouille avec le secret `LOOI_KEYSTORE_PASSWORD` (Settings → Secrets and variables → Actions). Grâce à elle, chaque nouvelle version s'installe par-dessus l'ancienne en gardant la mémoire et les réglages. Garde ce mot de passe précieusement : sans lui, impossible de publier une mise à jour installable par-dessus.

N'utilise pas le bouton « Mises à jour » dans l'app : il pointe vers la version d'origine (sans français), que ton téléphone refusera d'installer par-dessus celle-ci.
