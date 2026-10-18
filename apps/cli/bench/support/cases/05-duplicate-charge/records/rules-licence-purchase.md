# Code excerpt: licence purchase handler (synthetic)

```
 1 | export async function buyLicence(corp: Corp, req: LicenceRequest) {
 2 |   // NOTE: no check that req.requestId was already charged.
 3 |   await debitCash(corp, LICENCE_PRICE, req.requestId);
 4 |   const existing = await findLicence(corp, req.site);
 5 |   if (existing) return existing; // second click returns the same licence
 6 |   return grantLicence(corp, req.site);
 7 | }
```
