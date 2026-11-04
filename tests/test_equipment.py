import sys, unittest
sys.path.insert(0, 'src')
from finder import equipment_claims, condition_claims
class EquipmentTests(unittest.TestCase):
    def test_negative_and_fault_context_preserved(self):
        quote = 'The Night View system does not work; no rear-seat DVD is installed.'
        rows = equipment_claims([quote])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['quote'] == quote for row in rows))
    def test_qualifications_and_origin_preserved(self):
        quote = 'An aftermarket DVD player accompanies the factory Night View system.'
        rows = condition_claims([quote])['equipment_evidence']
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['quote'] == quote for row in rows))
    def test_unmentioned_unknown(self):
        self.assertEqual(equipment_claims(['Leather seats and navigation.']), [])
        self.assertNotIn('equipment_evidence', condition_claims(['Leather seats.']))
    def test_deduplicate_and_support_audio(self):
        quote = 'Equipment includes Mark Levinson audio and Apple CarPlay.'
        rows = equipment_claims([quote, quote])
        self.assertEqual(len(rows), 2)
    def test_long_paragraph_not_truncated_into_false_claim(self):
        self.assertEqual(equipment_claims(['Night View ' + 'x' * 701]), [])
if __name__ == '__main__': unittest.main()
