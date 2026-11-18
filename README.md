# Debout !

Le réveil entre potes. Ce sont tes amis qui choisissent avec quoi tu te lèves : un son, un message, un vocal, un défi pour couper.

C'est une appli web installable (PWA). Elle marche pareil sur iPhone et sur Android, sans passer par les stores.

## Ce qu'on peut faire

- **Bandes** : un groupe de potes (jusqu'à 30) qu'on rejoint avec un lien ou un code à 6 caractères. On peut être dans plusieurs bandes.
- **Mes réveils** : tes heures de réveil, visibles par tes potes.
- **Piéger un réveil** : un pote choisit le son de ta prochaine sonnerie, ajoute un message, un vocal de 12 s et un défi.
- **Réveil surprise** : un pote fait sonner ton téléphone à l'heure de son choix.
- **Surprise de la semaine** : chaque semaine, un son exclusif et son défi.
- **Défis pour couper** : taper 40 fois, 3 calculs, recopier une phrase, tenir 8 s, mémoriser des couleurs.
- **Le fil** : qui a piégé qui, qui s'est levé en combien de temps, qui a snoozé, les réactions et les trophées du mois.
- **Mode dodo** : appli ouverte, téléphone sur le chargeur. La sonnerie est forte et fiable, avec les vocaux.
- **Notifications** : en secours, quand l'appli est fermée. Sur iPhone, il faut d'abord ajouter l'appli à l'écran d'accueil.

## Organisation du code

- `index.html`, `css/`, `js/` : l'appli, en JavaScript sans framework ni étape de build.
- `sw.js` : le service worker (cache hors ligne et notifications).
- `sounds/` : les sons, tous synthétisés par `tools/gen_sounds.py`.
- `supabase/schema.sql` puis `supabase/security.sql` : la base et l'API (fonctions RPC). Chaque joueur a un jeton secret stocké sur son téléphone.
- `supabase/functions/push-tick` : la fonction qui envoie les notifications, appelée chaque minute par `supabase/cron.sql`.
- `tools/devserver.js` + `tools/e2e.py` : le serveur local et le test de bout en bout.

## Sécurité

- Pour créer un compte, il faut le **mot de passe d'accès** commun. Il n'est pas dans ce dépôt : seule son empreinte bcrypt est stockée dans la base.
- Les essais sont limités : 8 mots de passe ratés par heure et par connexion, 10 codes de bande ratés par heure et par compte.
- Les tables ne sont pas accessibles directement. Tout passe par des fonctions qui vérifient le jeton secret du joueur et son appartenance à la bande.
- Le créateur d'une bande peut exclure un membre et changer le code d'invitation.
- Les clés des notifications et le secret du relais sont stockés dans la base, pas dans le code.

## Hébergement

- Site : GitHub Pages (gratuit).
- Données et notifications : Supabase (offre gratuite).

Si personne n'utilise l'appli pendant 7 jours, Supabase met le projet en pause. Il faut alors le relancer depuis le tableau de bord Supabase.
