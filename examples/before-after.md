# Perch CTA instrumentation examples

Add `data-perch-cta` to the existing clickable element. Use a short kebab-case ID in the form `<intent>-<location>`. Instrument the page; do not restructure it.

## 1. Hero sign-up link

Before:

```html
<a class="button primary" href="/signup">Start free</a>
```

After:

```html
<a class="button primary" href="/signup" data-perch-cta="signup-hero">Start free</a>
```

## 2. Navigation demo button with nested markup

Before:

```html
<button class="nav-demo" type="button">
  <span>Book a demo</span>
</button>
```

After:

```html
<button class="nav-demo" type="button" data-perch-cta="demo-nav">
  <span>Book a demo</span>
</button>
```

Perch uses delegated capture-phase click handling, so a click on the inner `<span>` is counted once.

## 3. Pricing purchase button

Before:

```html
<button type="submit" class="buy">Choose Pro</button>
```

After:

```html
<button type="submit" class="buy" data-perch-cta="buy-pro-pricing">Choose Pro</button>
```

## 4. Footer download link

Before:

```html
<a href="/press-kit.zip" download>Download press kit</a>
```

After:

```html
<a href="/press-kit.zip" download data-perch-cta="download-footer">Download press kit</a>
```

## Custom event example

Use a custom event only when a meaningful action has no click target you can instrument, or when success happens asynchronously:

```js
window.perch?.track("newsletter_signup", {
  source: "footer",
  variant: "short-form"
});
```

Never send email addresses, names, phone numbers, free-form messages, account IDs, or other personal information in the event name or properties.
