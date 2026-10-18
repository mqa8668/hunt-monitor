# Renders docs/media/hero.gif. Run from the repo root:
#   DATABASE_URL=postgres://... vhs docs/demo/hero.tape
# DATABASE_URL must point at a migrated, seeded, empty database (bun run db:migrate && bun run db:seed).
# Everything shown is synthetic: the bundled demo sample, no network, no real listings.

Output docs/media/hero.gif

Set Shell "bash"
Set FontSize 17
Set Width 1180
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 20

Hide
Type `export PS1='$ ' && hunt() { bun apps/cli/src/index.ts "$@"; } && clear`
Enter
Sleep 1s
Show

Type "# try three watches on a sample feed, no database"
Enter
Sleep 600ms
Type "hunt match --dry-run"
Sleep 500ms
Enter
Sleep 9s

Type "clear"
Enter
Type "# save a new watch"
Enter
Sleep 600ms
Type `hunt watch add 'leica q2 <$3000 -broken'`
Sleep 500ms
Enter
Sleep 3s
Type "hunt watch list"
Sleep 500ms
Enter
Sleep 4s
