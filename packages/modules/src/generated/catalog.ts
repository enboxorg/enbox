import type { ModuleCatalogEntry } from '../catalog-types.js';
import type { TypedModule } from '@enbox/api';

import { BelongingsCatalog } from './belongings.js';
import { BelongingsModule } from './belongings.js';
import { BillsCatalog } from './bills.js';
import { BillsModule } from './bills.js';
import { BookmarksCatalog } from './bookmarks.js';
import { BookmarksModule } from './bookmarks.js';
import { BooksCatalog } from './books.js';
import { BooksModule } from './books.js';
import { BudgetsCatalog } from './budgets.js';
import { BudgetsModule } from './budgets.js';
import { CardsPassesCatalog } from './cards-passes.js';
import { CardsPassesModule } from './cards-passes.js';
import { CareerHistoryCatalog } from './career-history.js';
import { CareerHistoryModule } from './career-history.js';
import { CollaborationCatalog } from './collaboration.js';
import { CollaborationModule } from './collaboration.js';
import { ConnectCatalog } from './connect.js';
import { ConnectModule } from './connect.js';
import { ContactsCatalog } from './contacts.js';
import { ContactsModule } from './contacts.js';
import { ConversationsCatalog } from './conversations.js';
import { ConversationsModule } from './conversations.js';
import { CredentialsCatalog } from './credentials.js';
import { CredentialsModule } from './credentials.js';
import { CycleTrackingCatalog } from './cycle-tracking.js';
import { CycleTrackingModule } from './cycle-tracking.js';
import { DebtsLoansCatalog } from './debts-loans.js';
import { DebtsLoansModule } from './debts-loans.js';
import { DevicesCatalog } from './devices.js';
import { DevicesModule } from './devices.js';
import { EventsCatalog } from './events.js';
import { EventsModule } from './events.js';
import { FilesCatalog } from './files.js';
import { FilesModule } from './files.js';
import { FinancialAccountsCatalog } from './financial-accounts.js';
import { FinancialAccountsModule } from './financial-accounts.js';
import { FlashcardsCatalog } from './flashcards.js';
import { FlashcardsModule } from './flashcards.js';
import { FoodDiaryCatalog } from './food-diary.js';
import { FoodDiaryModule } from './food-diary.js';
import { GamesCatalog } from './games.js';
import { GamesModule } from './games.js';
import { GiftsCatalog } from './gifts.js';
import { GiftsModule } from './gifts.js';
import { GoalsCatalog } from './goals.js';
import { GoalsModule } from './goals.js';
import { GroceriesCatalog } from './groceries.js';
import { GroceriesModule } from './groceries.js';
import { HabitsCatalog } from './habits.js';
import { HabitsModule } from './habits.js';
import { HealthProfileCatalog } from './health-profile.js';
import { HealthProfileModule } from './health-profile.js';
import { HousingCatalog } from './housing.js';
import { HousingModule } from './housing.js';
import { IdentityDocumentsCatalog } from './identity-documents.js';
import { IdentityDocumentsModule } from './identity-documents.js';
import { InsuranceCatalog } from './insurance.js';
import { InsuranceModule } from './insurance.js';
import { InvestmentHoldingsCatalog } from './investment-holdings.js';
import { InvestmentHoldingsModule } from './investment-holdings.js';
import { LearningPlansCatalog } from './learning-plans.js';
import { LearningPlansModule } from './learning-plans.js';
import { MaintenanceCatalog } from './maintenance.js';
import { MaintenanceModule } from './maintenance.js';
import { MealPlansCatalog } from './meal-plans.js';
import { MealPlansModule } from './meal-plans.js';
import { MeasurementsCatalog } from './measurements.js';
import { MeasurementsModule } from './measurements.js';
import { MedicalRecordsCatalog } from './medical-records.js';
import { MedicalRecordsModule } from './medical-records.js';
import { MedicationsCatalog } from './medications.js';
import { MedicationsModule } from './medications.js';
import { MoodCatalog } from './mood.js';
import { MoodModule } from './mood.js';
import { MoviesTvCatalog } from './movies-tv.js';
import { MoviesTvModule } from './movies-tv.js';
import { MusicCatalog } from './music.js';
import { MusicModule } from './music.js';
import { NotebookCatalog } from './notebook.js';
import { NotebookModule } from './notebook.js';
import { NotebookRealtimeCatalog } from './notebook-realtime.js';
import { NotebookRealtimeModule } from './notebook-realtime.js';
import { OnlineAccountsCatalog } from './online-accounts.js';
import { OnlineAccountsModule } from './online-accounts.js';
import { PackingCatalog } from './packing.js';
import { PackingModule } from './packing.js';
import { PantryCatalog } from './pantry.js';
import { PantryModule } from './pantry.js';
import { PersonalProjectsCatalog } from './personal-projects.js';
import { PersonalProjectsModule } from './personal-projects.js';
import { PetCareCatalog } from './pet-care.js';
import { PetCareModule } from './pet-care.js';
import { PlacesCatalog } from './places.js';
import { PlacesModule } from './places.js';
import { PlantsCatalog } from './plants.js';
import { PlantsModule } from './plants.js';
import { PodcastsCatalog } from './podcasts.js';
import { PodcastsModule } from './podcasts.js';
import { PreferencesCatalog } from './preferences.js';
import { PreferencesModule } from './preferences.js';
import { ProfileCatalog } from './profile.js';
import { ProfileModule } from './profile.js';
import { PurchasesCatalog } from './purchases.js';
import { PurchasesModule } from './purchases.js';
import { ReceiptsCatalog } from './receipts.js';
import { ReceiptsModule } from './receipts.js';
import { RecipesCatalog } from './recipes.js';
import { RecipesModule } from './recipes.js';
import { RelationshipsCatalog } from './relationships.js';
import { RelationshipsModule } from './relationships.js';
import { ReservationsCatalog } from './reservations.js';
import { ReservationsModule } from './reservations.js';
import { RoutesCatalog } from './routes.js';
import { RoutesModule } from './routes.js';
import { SharedExpensesCatalog } from './shared-expenses.js';
import { SharedExpensesModule } from './shared-expenses.js';
import { SharedGroceriesCatalog } from './shared-groceries.js';
import { SharedGroceriesModule } from './shared-groceries.js';
import { SharedMealPlansCatalog } from './shared-meal-plans.js';
import { SharedMealPlansModule } from './shared-meal-plans.js';
import { SharedTasksCatalog } from './shared-tasks.js';
import { SharedTasksModule } from './shared-tasks.js';
import { ShoppingWishlistsCatalog } from './shopping-wishlists.js';
import { ShoppingWishlistsModule } from './shopping-wishlists.js';
import { SleepCatalog } from './sleep.js';
import { SleepModule } from './sleep.js';
import { StockWatchlistsCatalog } from './stock-watchlists.js';
import { StockWatchlistsModule } from './stock-watchlists.js';
import { SubscriptionsCatalog } from './subscriptions.js';
import { SubscriptionsModule } from './subscriptions.js';
import { SymptomsCatalog } from './symptoms.js';
import { SymptomsModule } from './symptoms.js';
import { TasksCatalog } from './tasks.js';
import { TasksModule } from './tasks.js';
import { TimeEntriesCatalog } from './time-entries.js';
import { TimeEntriesModule } from './time-entries.js';
import { TransactionsCatalog } from './transactions.js';
import { TransactionsModule } from './transactions.js';
import { TripsCatalog } from './trips.js';
import { TripsModule } from './trips.js';
import { UtilitiesCatalog } from './utilities.js';
import { UtilitiesModule } from './utilities.js';
import { VehiclesCatalog } from './vehicles.js';
import { VehiclesModule } from './vehicles.js';
import { WarrantiesCatalog } from './warranties.js';
import { WarrantiesModule } from './warranties.js';
import { WorkoutsCatalog } from './workouts.js';
import { WorkoutsModule } from './workouts.js';

export const moduleCatalog: readonly ModuleCatalogEntry[] = Object.freeze([
  BelongingsCatalog,
  BillsCatalog,
  BookmarksCatalog,
  BooksCatalog,
  BudgetsCatalog,
  CardsPassesCatalog,
  CareerHistoryCatalog,
  CollaborationCatalog,
  ConnectCatalog,
  ContactsCatalog,
  ConversationsCatalog,
  CredentialsCatalog,
  CycleTrackingCatalog,
  DebtsLoansCatalog,
  DevicesCatalog,
  EventsCatalog,
  FilesCatalog,
  FinancialAccountsCatalog,
  FlashcardsCatalog,
  FoodDiaryCatalog,
  GamesCatalog,
  GiftsCatalog,
  GoalsCatalog,
  GroceriesCatalog,
  HabitsCatalog,
  HealthProfileCatalog,
  HousingCatalog,
  IdentityDocumentsCatalog,
  InsuranceCatalog,
  InvestmentHoldingsCatalog,
  LearningPlansCatalog,
  MaintenanceCatalog,
  MealPlansCatalog,
  MeasurementsCatalog,
  MedicalRecordsCatalog,
  MedicationsCatalog,
  MoodCatalog,
  MoviesTvCatalog,
  MusicCatalog,
  NotebookCatalog,
  NotebookRealtimeCatalog,
  OnlineAccountsCatalog,
  PackingCatalog,
  PantryCatalog,
  PersonalProjectsCatalog,
  PetCareCatalog,
  PlacesCatalog,
  PlantsCatalog,
  PodcastsCatalog,
  PreferencesCatalog,
  ProfileCatalog,
  PurchasesCatalog,
  ReceiptsCatalog,
  RecipesCatalog,
  RelationshipsCatalog,
  ReservationsCatalog,
  RoutesCatalog,
  SharedExpensesCatalog,
  SharedGroceriesCatalog,
  SharedMealPlansCatalog,
  SharedTasksCatalog,
  ShoppingWishlistsCatalog,
  SleepCatalog,
  StockWatchlistsCatalog,
  SubscriptionsCatalog,
  SymptomsCatalog,
  TasksCatalog,
  TimeEntriesCatalog,
  TransactionsCatalog,
  TripsCatalog,
  UtilitiesCatalog,
  VehiclesCatalog,
  WarrantiesCatalog,
  WorkoutsCatalog,
]);
export const standardModules: readonly TypedModule[] = Object.freeze([
  BelongingsModule,
  BillsModule,
  BookmarksModule,
  BooksModule,
  BudgetsModule,
  CardsPassesModule,
  CareerHistoryModule,
  CollaborationModule,
  ConnectModule,
  ContactsModule,
  ConversationsModule,
  CredentialsModule,
  CycleTrackingModule,
  DebtsLoansModule,
  DevicesModule,
  EventsModule,
  FilesModule,
  FinancialAccountsModule,
  FlashcardsModule,
  FoodDiaryModule,
  GamesModule,
  GiftsModule,
  GoalsModule,
  GroceriesModule,
  HabitsModule,
  HealthProfileModule,
  HousingModule,
  IdentityDocumentsModule,
  InsuranceModule,
  InvestmentHoldingsModule,
  LearningPlansModule,
  MaintenanceModule,
  MealPlansModule,
  MeasurementsModule,
  MedicalRecordsModule,
  MedicationsModule,
  MoodModule,
  MoviesTvModule,
  MusicModule,
  NotebookModule,
  NotebookRealtimeModule,
  OnlineAccountsModule,
  PackingModule,
  PantryModule,
  PersonalProjectsModule,
  PetCareModule,
  PlacesModule,
  PlantsModule,
  PodcastsModule,
  PreferencesModule,
  ProfileModule,
  PurchasesModule,
  ReceiptsModule,
  RecipesModule,
  RelationshipsModule,
  ReservationsModule,
  RoutesModule,
  SharedExpensesModule,
  SharedGroceriesModule,
  SharedMealPlansModule,
  SharedTasksModule,
  ShoppingWishlistsModule,
  SleepModule,
  StockWatchlistsModule,
  SubscriptionsModule,
  SymptomsModule,
  TasksModule,
  TimeEntriesModule,
  TransactionsModule,
  TripsModule,
  UtilitiesModule,
  VehiclesModule,
  WarrantiesModule,
  WorkoutsModule,
]);
