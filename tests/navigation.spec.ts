import { test, expect } from '@playwright/test';

test.describe('Navigation Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Acesse a home page antes de cada teste
    await page.goto('http://localhost:3000');
  });

  test('should navigate to Search Cards page', async ({ page }) => {
    await page.click('text=Search Cards');
    await expect(page).toHaveURL(/.*\/search/);
  });

  test('should navigate to Generate Deck page', async ({ page }) => {
    await page.click('text=Generate Deck');
    await expect(page).toHaveURL(/.*\/generator/);
  });

  test('should navigate to Full Pipeline page', async ({ page }) => {
    await page.click('text=Full Pipeline');
    await expect(page).toHaveURL(/.*\/pipeline/);
  });

  test('should navigate to Archetype Builder page', async ({ page }) => {
    await page.click('text=Archetype Builder');
    await expect(page).toHaveURL(/.*\/archetype/);
  });

  test('should navigate to Sync Data page', async ({ page }) => {
    await page.click('text=Sync Data');
    await expect(page).toHaveURL(/.*\/sync/);
  });

  test('should navigate to Cluster Analysis page', async ({ page }) => {
    await page.click('text=Cluster Analysis');
    await expect(page).toHaveURL(/.*\/clustering/);
  });

  test('should navigate to Synergy Graph page', async ({ page }) => {
    await page.click('text=Synergy Graph');
    await expect(page).toHaveURL(/.*\/synergy/);
  });

  test('should navigate to Deck Art page', async ({ page }) => {
    await page.click('text=Deck Art');
    await expect(page).toHaveURL(/.*\/visualization/);
  });

  test('should navigate to Share Decks page', async ({ page }) => {
    await page.click('text=Share Decks');
    await expect(page).toHaveURL(/.*\/sharing/);
  });
});
