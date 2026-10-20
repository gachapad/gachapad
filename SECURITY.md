# Security

If you find a bug that could move money the wrong way, please don't open a public issue. Report it privately through GitHub's **Report a vulnerability** button on this repository. Please include a description and, if you can, the steps or transaction that show it.

Most sensitive:
- burn verification in `backend/pulls.js`;
- the freeze and draw in `backend/pulls.js`;
- pack purchases in `backend/packs.js`;
- the fee-sharing lock in `backend/launch.js`;
- the buy-and-burn in `backend/burner.js`.

No keys live in this repository. The engine reads them from its environment only.
