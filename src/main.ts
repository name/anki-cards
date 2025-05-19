import { App, Notice, Plugin, TFile, Modal, MarkdownRenderer, PluginSettingTab, Setting } from 'obsidian';

interface AnkiCard {
  id: string;
  front: string;
  back: string;
  sourceFile: string;
  position: number;
  // SRS fields
  lastReviewed?: number; // timestamp
  nextReview?: number; // timestamp
  easeFactor?: number; // 1.0 to 2.5, default 2.5
  interval?: number; // days
  reviewCount?: number; // number of times reviewed
}

interface AnkiData {
  timestamp: string;
  totalCards: number;
  cards: AnkiCard[];
}

interface AnkiPluginSettings {
  // Review Session Settings
  cardsPerSession: number;
  newCardsPerDay: number;
  reviewsPerDay: number;

  // Card Display Settings
  showSourceFile: boolean;
  enableMarkdownRendering: boolean;

  // SRS Algorithm Settings
  easyBonus: number;
  intervalModifier: number;
  maxInterval: number;

  // Interface Settings
  darkModeButtons: boolean;

  // Automatic Indexing Settings
  enableAutomaticIndexing: boolean;
}

const DEFAULT_SETTINGS: AnkiPluginSettings = {
  // Default Review Session Settings
  cardsPerSession: 5,
  newCardsPerDay: 10,
  reviewsPerDay: 50,

  // Default Card Display Settings
  showSourceFile: true,
  enableMarkdownRendering: true,

  // Default SRS Algorithm Settings
  easyBonus: 1.3, // Multiplier for ease factor when "Easy" is selected
  intervalModifier: 1.0, // Overall multiplier for intervals
  maxInterval: 365, // Maximum interval in days

  // Interface Settings
  darkModeButtons: true,

  // Default Automatic Indexing Settings
  enableAutomaticIndexing: true
};

export default class AnkiPlugin extends Plugin {
  settings: AnkiPluginSettings;
  cardData: AnkiData | null = null;

  async onload() {
    // Load settings
    await this.loadSettings();

    // Load card data
    await this.loadCardData();

    // Add settings tab
    this.addSettingTab(new AnkiSettingTab(this.app, this));

    // Add the Anki ribbon icon
    this.addRibbonIcon('square-asterisk', 'Review Anki Cards', () => {
      this.reviewCards();
    });

    // Add a command to index cards
    this.addCommand({
      id: 'index-anki-cards',
      name: 'Index all Anki cards in vault',
      callback: () => this.indexAnkiCards()
    });

    // Add a command to review cards
    this.addCommand({
      id: 'review-anki-cards',
      name: 'Review indexed Anki cards',
      callback: () => this.reviewCards()
    });

    // Add command to view all cards
    this.addCommand({
      id: 'view-all-anki-cards',
      name: 'View all indexed Anki cards',
      callback: () => this.viewAllCards()
    });

    // Register for layout-ready event to index cards after app is fully loaded
    if (this.settings.enableAutomaticIndexing) {
      this.app.workspace.onLayoutReady(() => {
        // Delay indexing to avoid freezing the app during startup
        setTimeout(() => {
          this.indexAnkiCards(false); // Silent indexing (no notifications)
        }, 5000); // 5 second delay
      });
    }

    console.log('Anki plugin loaded');
  }

  onunload() {
    console.log('Anki plugin unloaded');
  }

  // Load settings from disk
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);

    // Set default value for new setting if it doesn't exist
    if (this.settings.enableAutomaticIndexing === undefined) {
      this.settings.enableAutomaticIndexing = true;
    }
  }

  // Save settings to disk
  async saveSettings() {
    // Preserve existing data structure
    const data = await this.loadData() || {};
    data.settings = this.settings;
    await this.saveData(data);
  }

  // Load card data from disk
  async loadCardData() {
    const data = await this.loadData();
    this.cardData = data?.cards || null;
  }

  // Save card data to disk
  async saveCardData(cards: AnkiData) {
    // Preserve existing data structure
    const data = await this.loadData() || {};
    data.cards = cards;
    await this.saveData(data);
    this.cardData = cards;
  }

  async reviewCards() {
    await this.loadCardData();

    if (!this.cardData || !this.cardData.cards || this.cardData.cards.length === 0) {
      new Notice('No indexed cards found. Run the indexing command first.');
      return;
    }

    // Get cards due for review
    const now = Date.now();
    let dueCards = this.cardData.cards.filter(card =>
      !card.nextReview || card.nextReview <= now
    );

    // If no cards are due, use cards that haven't been reviewed yet
    if (dueCards.length === 0) {
      // Limit new cards per day
      dueCards = this.cardData.cards
        .filter(card => !card.lastReviewed)
        .slice(0, this.settings.newCardsPerDay);
    } else {
      // Limit reviews per day
      dueCards = dueCards.slice(0, this.settings.reviewsPerDay);
    }

    // If still no cards, show options modal instead of just a message
    if (dueCards.length === 0) {
      new NoCardsModal(this.app, this).open();
      return;
    }

    // Randomize and limit to cardsPerSession
    const reviewSize = Math.min(this.settings.cardsPerSession, dueCards.length);
    const cardsToReview = this.getRandomSubset(dueCards, reviewSize);

    new Notice(`Reviewing ${reviewSize} cards`);
    new CardReviewModal(this.app, cardsToReview, this).open();
  }

  async viewAllCards() {
    await this.loadCardData();

    if (this.cardData && this.cardData.cards && this.cardData.cards.length > 0) {
      new Notice(`Viewing all ${this.cardData.cards.length} cards`);
      new CardListModal(this.app, this.cardData.cards).open();
    } else {
      new Notice('No indexed cards found. Run the indexing command first.');
    }
  }

  getRandomSubset(array: any[], size: number): any[] {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
  }

  // Modify indexAnkiCards to accept a silent mode parameter
  async indexAnkiCards(showNotifications: boolean = true) {
    const startTime = Date.now();
    if (showNotifications) {
      new Notice('Starting Anki card indexing...');
    }

    const files = this.app.vault.getMarkdownFiles();
    let allCards: AnkiCard[] = [];
    let processedCount = 0;

    // Load existing cards to preserve SRS data
    await this.loadCardData();
    const existingCards: Record<string, AnkiCard> = {};
    let oldCardCount = 0;

    if (this.cardData && this.cardData.cards) {
      this.cardData.cards.forEach(card => {
        existingCards[card.id] = card;
      });
      oldCardCount = this.cardData.cards.length;
    }

    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const cardsInFile = this.findAnkiCardsInContent(content, file.basename);

        if (cardsInFile.length > 0) {
          // Merge with existing SRS data if available
          cardsInFile.forEach(card => {
            if (existingCards[card.id]) {
              const existingCard = existingCards[card.id];
              // Preserve SRS data
              card.lastReviewed = existingCard.lastReviewed;
              card.nextReview = existingCard.nextReview;
              card.easeFactor = existingCard.easeFactor;
              card.interval = existingCard.interval;
              card.reviewCount = existingCard.reviewCount;
            } else {
              // Initialize SRS data for new cards
              card.easeFactor = 2.5; // Default ease factor
              card.interval = 0;
              card.reviewCount = 0;
            }
          });

          allCards = allCards.concat(cardsInFile);
          processedCount++;
        }
      } catch (error) {
        console.error(`Error processing file ${file.path}:`, error);
      }
    }

    if (allCards.length > 0) {
      await this.saveCardsToJson(allCards);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // Show notifications only if requested
      if (showNotifications) {
        const newCardCount = allCards.length - oldCardCount;
        if (newCardCount > 0) {
          new Notice(`Indexed ${allCards.length} Anki cards (${newCardCount} new) from ${processedCount} files in ${duration}s`);
        } else {
          new Notice(`Indexed ${allCards.length} Anki cards from ${processedCount} files in ${duration}s`);
        }
      } else {
        // Just log to console in silent mode
        const newCardCount = allCards.length - oldCardCount;
        if (newCardCount > 0) {
          console.log(`[Anki] Silently indexed ${allCards.length} Anki cards (${newCardCount} new) in ${duration}s`);
        }
      }
    } else if (showNotifications) {
      new Notice('No Anki cards found in vault');
    }
  }

  findAnkiCardsInContent(content: string, fileName: string): AnkiCard[] {
    const cards: AnkiCard[] = [];

    // Find all ```anki ... ``` blocks
    const ankiBlockRegex = /```anki\n([\s\S]*?)\n```/g;
    let match;

    while ((match = ankiBlockRegex.exec(content)) !== null) {
      const blockContent = match[1];
      const position = match.index;

      // Split the block content into cards (if multiple cards in one block)
      // Modified regex to better handle newlines
      const cardContents = blockContent.split(/\n\n(?=[\s\S]+?\n\?\n)/g);

      for (const cardContent of cardContents) {
        // Split by question/answer separator
        const parts = cardContent.split(/\n\?\n/);

        if (parts.length === 2) {
          cards.push({
            id: this.generateCardId(parts[0].trim(), parts[1].trim(), fileName),
            front: parts[0].trim(),
            back: parts[1].trim(),
            sourceFile: fileName,
            position: position
          });
        }
      }
    }

    return cards;
  }

  generateCardId(front: string, back: string, sourceFile: string): string {
    // Create a deterministic ID based on content
    const contentString = `${front}|${back}|${sourceFile}`;
    let hash = 0;
    for (let i = 0; i < contentString.length; i++) {
      const char = contentString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return 'card_' + Math.abs(hash).toString(36);
  }

  async saveCardsToJson(cards: AnkiCard[]) {
    try {
      // Create the data object with metadata
      const cardData = {
        timestamp: new Date().toISOString(),
        totalCards: cards.length,
        cards: cards
      };

      // Save the cards data separately
      await this.saveCardData(cardData);

      console.log(`Saved ${cards.length} cards to plugin data storage`);
    } catch (error) {
      console.error('Error saving cards to JSON:', error);
      new Notice('Error saving Anki cards to JSON');
    }
  }

  // SRS algorithm functions
  calculateNextReview(card: AnkiCard, difficultyRating: number): AnkiCard {
    const now = Date.now();

    // Initialize if first review
    if (!card.easeFactor) card.easeFactor = 2.5;
    if (!card.interval) card.interval = 0;
    if (!card.reviewCount) card.reviewCount = 0;

    // Update card properties
    card.lastReviewed = now;
    card.reviewCount++;

    // Update ease factor based on rating (1=hard, 2=good, 3=easy)
    switch (difficultyRating) {
      case 1: // Hard
        card.easeFactor = Math.max(1.3, card.easeFactor - 0.15);
        break;
      case 2: // Good
        // No change to ease factor
        break;
      case 3: // Easy
        card.easeFactor = Math.min(2.5, card.easeFactor + 0.15 * this.settings.easyBonus);
        break;
    }

    // Calculate new interval
    if (card.interval === 0) {
      // First review
      switch (difficultyRating) {
        case 1: // Hard
          card.interval = 1; // 1 day
          break;
        case 2: // Good
          card.interval = 3; // 3 days
          break;
        case 3: // Easy
          card.interval = 7; // 7 days
          break;
      }
    } else {
      // Subsequent reviews
      card.interval = Math.round(card.interval * card.easeFactor * this.settings.intervalModifier);

      // Cap maximum interval
      card.interval = Math.min(card.interval, this.settings.maxInterval);
    }

    // Calculate next review date
    const millisecondsPerDay = 24 * 60 * 60 * 1000;
    card.nextReview = now + (card.interval * millisecondsPerDay);

    return card;
  }

  async updateCardAfterReview(card: AnkiCard, difficultyRating: number) {
    // Update the card using SRS algorithm
    this.calculateNextReview(card, difficultyRating);

    // Make sure card data is loaded
    await this.loadCardData();
    if (!this.cardData || !this.cardData.cards) return;

    // Find and update the reviewed card
    const cardIndex = this.cardData.cards.findIndex(c => c.id === card.id);
    if (cardIndex !== -1) {
      this.cardData.cards[cardIndex] = card;

      // Save back to storage
      await this.saveCardData(this.cardData);
    }
  }
}

class AnkiSettingTab extends PluginSettingTab {
  plugin: AnkiPlugin;

  constructor(app: App, plugin: AnkiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Anki Cards Settings' });

    // Review Session Settings
    containerEl.createEl('h3', { text: 'Review Session' });

    new Setting(containerEl)
      .setName('Cards per session')
      .setDesc('Number of cards to review in each session')
      .addSlider(slider => slider
        .setLimits(1, 50, 1)
        .setValue(this.plugin.settings.cardsPerSession)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.cardsPerSession = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('New cards per day')
      .setDesc('Maximum number of new cards to introduce each day')
      .addSlider(slider => slider
        .setLimits(0, 50, 1)
        .setValue(this.plugin.settings.newCardsPerDay)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.newCardsPerDay = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Reviews per day')
      .setDesc('Maximum number of review cards to show each day')
      .addSlider(slider => slider
        .setLimits(1, 200, 1)
        .setValue(this.plugin.settings.reviewsPerDay)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.reviewsPerDay = value;
          await this.plugin.saveSettings();
        }));

    // Card Display Settings
    containerEl.createEl('h3', { text: 'Card Display' });

    new Setting(containerEl)
      .setName('Show source file')
      .setDesc('Show the source file name on cards')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showSourceFile)
        .onChange(async (value) => {
          this.plugin.settings.showSourceFile = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable markdown rendering')
      .setDesc('Render markdown in questions and answers')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableMarkdownRendering)
        .onChange(async (value) => {
          this.plugin.settings.enableMarkdownRendering = value;
          await this.plugin.saveSettings();
        }));

    // SRS Algorithm Settings
    containerEl.createEl('h3', { text: 'Spaced Repetition (Advanced)' });

    new Setting(containerEl)
      .setName('Easy bonus')
      .setDesc('Extra multiplier for the "Easy" button (higher = longer intervals)')
      .addSlider(slider => slider
        .setLimits(1.0, 2.0, 0.1)
        .setValue(this.plugin.settings.easyBonus)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.easyBonus = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Interval modifier')
      .setDesc('Global multiplier for all intervals (higher = longer intervals)')
      .addSlider(slider => slider
        .setLimits(0.5, 2.0, 0.1)
        .setValue(this.plugin.settings.intervalModifier)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.intervalModifier = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Maximum interval')
      .setDesc('Longest possible interval between reviews (in days)')
      .addSlider(slider => slider
        .setLimits(30, 1000, 5)
        .setValue(this.plugin.settings.maxInterval)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxInterval = value;
          await this.plugin.saveSettings();
        }));

    // Interface Settings
    containerEl.createEl('h3', { text: 'Interface' });

    new Setting(containerEl)
      .setName('Dark mode buttons')
      .setDesc('Use darker colors for rating buttons (may look better in dark themes)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.darkModeButtons)
        .onChange(async (value) => {
          this.plugin.settings.darkModeButtons = value;
          await this.plugin.saveSettings();
        }));

    // Automatic Indexing Settings
    containerEl.createEl('h3', { text: 'Automatic Indexing' });

    new Setting(containerEl)
      .setName('Enable automatic indexing')
      .setDesc('Automatically index cards when Obsidian starts')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAutomaticIndexing)
        .onChange(async (value) => {
          this.plugin.settings.enableAutomaticIndexing = value;
          await this.plugin.saveSettings();
        }));
  }
}

class CardReviewModal extends Modal {
  cards: AnkiCard[];
  currentIndex: number = 0;
  showingAnswer: boolean = false;
  plugin: AnkiPlugin;

  constructor(app: App, cards: AnkiCard[], plugin: AnkiPlugin) {
    super(app);
    this.cards = cards;
    this.plugin = plugin;
  }

  onOpen() {
    this.renderCurrentCard();
  }

  async renderCurrentCard() {
    const { contentEl } = this;
    contentEl.empty();

    const card = this.cards[this.currentIndex];

    // Create header with card counter
    contentEl.createEl('h2', { text: `Card ${this.currentIndex + 1}/${this.cards.length}` });

    // Source file info (conditional based on settings)
    if (this.plugin.settings.showSourceFile) {
      const sourceEl = contentEl.createDiv('card-source');
      sourceEl.createSpan({ text: `Source: ${card.sourceFile}` });

      // Review stats if available
      if (card.reviewCount) {
        sourceEl.createEl('br');
        sourceEl.createSpan({
          text: `Reviews: ${card.reviewCount} | ` +
            `Ease: ${card.easeFactor?.toFixed(2)} | ` +
            `Interval: ${card.interval} days`
        });
      }
    }

    // Question section
    const questionEl = contentEl.createDiv('card-question');
    questionEl.createEl('h3', { text: 'Question:' });
    const questionContent = questionEl.createDiv('card-content');

    // Render markdown or plain text based on settings
    if (this.plugin.settings.enableMarkdownRendering) {
      await MarkdownRenderer.renderMarkdown(
        card.front,
        questionContent,
        card.sourceFile,
        this.plugin
      );
    } else {
      questionContent.setText(card.front);
    }

    // Answer section (conditionally shown)
    if (this.showingAnswer) {
      const answerEl = contentEl.createDiv('card-answer');
      answerEl.createEl('h3', { text: 'Answer:' });
      const answerContent = answerEl.createDiv('card-content');

      // Render markdown or plain text based on settings
      if (this.plugin.settings.enableMarkdownRendering) {
        await MarkdownRenderer.renderMarkdown(
          card.back,
          answerContent,
          card.sourceFile,
          this.plugin
        );
      } else {
        answerContent.setText(card.back);
      }

      // Rating buttons
      const ratingContainer = contentEl.createDiv('rating-container');
      ratingContainer.createEl('h3', { text: 'How well did you know this?' });

      // Apply dark mode to buttons if setting enabled
      const darkModeClass = this.plugin.settings.darkModeButtons ? ' dark-mode' : '';

      const hardButton = ratingContainer.createEl('button', {
        text: 'Hard',
        cls: 'rating-button rating-hard' + darkModeClass
      });
      hardButton.addEventListener('click', () => this.rateCard(1));

      const goodButton = ratingContainer.createEl('button', {
        text: 'Good',
        cls: 'rating-button rating-good' + darkModeClass
      });
      goodButton.addEventListener('click', () => this.rateCard(2));

      const easyButton = ratingContainer.createEl('button', {
        text: 'Easy',
        cls: 'rating-button rating-easy' + darkModeClass
      });
      easyButton.addEventListener('click', () => this.rateCard(3));
    } else {
      // Show answer button
      const showButtonContainer = contentEl.createDiv('show-button-container');
      const showButton = showButtonContainer.createEl('button', {
        text: 'Show Answer',
        cls: 'show-answer-button'
      });
      showButton.addEventListener('click', () => {
        this.showingAnswer = true;
        this.renderCurrentCard();
      });
    }
  }

  async rateCard(rating: number) {
    const currentCard = this.cards[this.currentIndex];

    // Update card with SRS data
    await this.plugin.updateCardAfterReview(currentCard, rating);

    // Move to next card
    this.showNextCard();
  }

  showNextCard() {
    if (this.currentIndex < this.cards.length - 1) {
      this.currentIndex++;
      this.showingAnswer = false;
      this.renderCurrentCard();
    } else {
      // End of cards
      new Notice('Review session complete!');
      this.close();
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class NoCardsModal extends Modal {
  plugin: AnkiPlugin;

  constructor(app: App, plugin: AnkiPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Create header
    contentEl.createEl('h2', { text: 'No Cards Due for Review' });

    contentEl.createEl('p', {
      text: 'You have no cards due for review right now. What would you like to do?'
    });

    // Container for buttons
    const buttonContainer = contentEl.createDiv('no-cards-options');

    // Option 1: Force review of cards anyway
    const reviewAnyway = buttonContainer.createEl('button', {
      text: 'Review Cards Anyway',
      cls: 'option-button'
    });
    reviewAnyway.addEventListener('click', () => {
      this.close();
      this.forceReviewCards();
    });

    // Option 2: Index new cards
    const indexCards = buttonContainer.createEl('button', {
      text: 'Index New Cards',
      cls: 'option-button'
    });
    indexCards.addEventListener('click', () => {
      this.close();
      this.plugin.indexAnkiCards();
    });

    // Option 3: Cancel
    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'option-button'
    });
    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  // Force review by ignoring due dates
  async forceReviewCards() {
    await this.plugin.loadCardData();

    if (!this.plugin.cardData || !this.plugin.cardData.cards || this.plugin.cardData.cards.length === 0) {
      new Notice('No cards available to review.');
      return;
    }

    // Get all cards, regardless of due date
    let allCards = [...this.plugin.cardData.cards];

    // Prioritize cards that haven't been reviewed
    allCards.sort((a, b) => {
      // Cards without review history come first
      if (!a.lastReviewed && b.lastReviewed) return -1;
      if (a.lastReviewed && !b.lastReviewed) return 1;

      // Then sort by oldest review date
      if (a.lastReviewed && b.lastReviewed) {
        return a.lastReviewed - b.lastReviewed;
      }

      return 0;
    });

    // Limit to cards per session
    const reviewSize = Math.min(this.plugin.settings.cardsPerSession, allCards.length);
    const cardsToReview = allCards.slice(0, reviewSize);

    new Notice(`Reviewing ${reviewSize} cards (forced review)`);
    new CardReviewModal(this.plugin.app, cardsToReview, this.plugin).open();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class CardListModal extends Modal {
  cards: AnkiCard[];

  constructor(app: App, cards: AnkiCard[]) {
    super(app);
    this.cards = cards;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Create header
    contentEl.createEl('h2', { text: 'All Anki Cards' });

    // Create a container with scrollbar
    const container = contentEl.createDiv('cards-list-container');

    // Sort cards by next review date
    const sortedCards = [...this.cards].sort((a, b) => {
      // Cards without next review date go first
      if (!a.nextReview && !b.nextReview) return 0;
      if (!a.nextReview) return -1;
      if (!b.nextReview) return 1;
      return a.nextReview - b.nextReview;
    });

    // Add cards to list
    sortedCards.forEach((card, index) => {
      const cardItem = container.createDiv('card-list-item');

      // Card header
      const header = cardItem.createDiv('card-list-header');
      header.createEl('strong', { text: `${index + 1}. ${this.truncateText(card.front.replace(/\n/g, ' '), 50)}` });

      // Card details
      const details = cardItem.createDiv('card-list-details');

      if (card.nextReview) {
        const dueDate = new Date(card.nextReview);
        const dueString = dueDate.toLocaleDateString();
        details.createDiv({ text: `Due: ${dueString}` });
      } else {
        details.createDiv({ text: 'Due: New card' });
      }

      details.createDiv({ text: `Source: ${card.sourceFile}` });

      if (card.reviewCount) {
        details.createDiv({
          text: `Reviews: ${card.reviewCount} | ` +
            `Ease: ${card.easeFactor?.toFixed(2)} | ` +
            `Interval: ${card.interval} days`
        });
      }
    });
  }

  truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
